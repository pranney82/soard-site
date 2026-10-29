/**
 * Admin → Site Config (loaded on first visit, like ./applications.js)
 * ===========================================================================
 * Everything on the public pages that isn't a kid, partner, person, event or
 * article: organized by the page it appears on, in the order it appears there.
 * A list of pages on the left (#site/<page>), the page's sections on the right.
 *
 *   - Photos show the crop the page uses (the same Cloudflare transform), with
 *     where else the photo appears; Change opens a picker of kids' photos, the
 *     whole image library, or an upload. Image IDs stay out of sight.
 *   - Words that allow emphasis are edited as text: ⌘I highlights (the site's
 *     yellow-marker italic), ⌘B bolds, ⌘K links. The stored HTML is the same
 *     markup the pages already render.
 *   - One Save for everything: only the fields changed since loading are laid
 *     onto a fresh copy of each document (./site-config-shared.js
 *     mergeForSave), so nobody's other edits are undone. A field someone else
 *     changed meanwhile is shown side by side to pick from.
 *   - History per page (content_versions, collection 'site'): compare an
 *     earlier version with now and put back just this page's fields.
 *   - ⌘S saves; leaving with unsaved changes asks first.
 *
 * Open/closed for applications is Admin → Applications → Settings, linked
 * from the Apply page here.
 */

import { h, htm, render, Component, useState, useEffect, useRef, useMemo, Sortable, DOMPurify } from './vendor.js';
import * as S from './site-config-shared.js';
import { floatRef } from './float.js';

const html = htm.bind(h);
const CF = `/cdn-cgi/imagedelivery/${S.CF_HASH}`;
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+';

// ─── Small helpers ─────────────────────────────────────────────────
/** An image URL for an ID or a site path (badges ship as /files in public/) */
function imgUrl(src, transforms) {
  const s = String(src || '');
  if (!s) return '';
  if (/^(blob:|data:)/.test(s) || (/^(\/|https?:)/.test(s) && !/imagedelivery/.test(s))) return s;
  const id = S.cfIdOf(s);
  return id ? `${CF}/${id}/${transforms}` : '';
}
const prefersReducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const when = (iso) => (iso ? new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${String(iso).replace(' ', 'T')}Z`).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const daysAgo = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 864e5) : null);
const personName = (email) => {
  const s = String(email || '');
  if (!s.includes('@')) return s || 'Someone';
  return s.split('@')[0].split(/[._+-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || s;
};
let uid = 0;
const useId = (p = 'sc') => { const r = useRef(null); if (!r.current) r.current = `${p}-${++uid}`; return r.current; };
function useNarrow(q = '(max-width: 900px)') {
  const [m, setM] = useState(() => { try { return matchMedia(q).matches; } catch { return false; } });
  useEffect(() => {
    let mq;
    try { mq = matchMedia(q); } catch { return undefined; }
    const on = () => setM(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return m;
}

async function call(path, body, opts = {}) {
  let r;
  try {
    r = await fetch(path, body instanceof FormData ? { method: 'POST', body } : body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store', ...opts });
  } catch {
    return { success: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: /cloudflareaccess/i.test(r.url || '') ? 'Your admin session expired. Reload the page and sign in again.' : `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  j.status = r.status;
  return j;
}

// ─── Icons (24px grid, stroked) ────────────────────────────────────
const ICONS = {
  grip: html`<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none" />`,
  up: html`<path d="M12 19V5M6 11l6-6 6 6" />`,
  down: html`<path d="M12 5v14M6 13l6 6 6-6" />`,
  close: html`<path d="M18 6 6 18M6 6l12 12" />`,
  trash: html`<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />`,
  ext: html`<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />`,
  plus: html`<path d="M12 5v14M5 12h14" />`,
  check: html`<path d="m5 12 5 5 9-10" />`,
  warn: html`<path d="M12 4 2.5 20h19L12 4z" /><path d="M12 10v4M12 17.5v.01" />`,
  search: html`<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />`,
  image: html`<rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" />`,
  upload: html`<path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />`,
  history: html`<path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" />`,
  back: html`<path d="M15 18l-6-6 6-6" />`,
  chevron: html`<path d="m6 9 6 6 6-6" />`,
  file: html`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />`,
  star: html`<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" />`,
  link: html`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />`,
  copy: html`<rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />`,
  refresh: html`<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />`,
};
const Icon = ({ name, size = 16 }) => html`<svg class="sc-ico" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

// ─── Documents: load, edit, save only what changed ─────────────────
async function readDoc(key) {
  const j = await call(`/api/read-content?path=${encodeURIComponent(S.docPath(key))}`);
  if (j.status === 404) return { data: {}, sha: null, missing: true };
  if (!j.success) return { error: j.error || 'Could not load it' };
  try { return { data: typeof j.content === 'string' ? JSON.parse(j.content) : (j.content || {}), sha: j.sha || null }; } catch { return { error: 'The saved copy could not be read' }; }
}

/** Shapes the editors expect; never written unless a field is edited (base gets the same) */
function normalize(key, d) {
  const data = d && typeof d === 'object' ? d : {};
  if (key === 'faq') return { ...data, categories: Array.isArray(data.categories) ? data.categories : [], items: Array.isArray(data.items) ? data.items : [] };
  if (key === 'financials') return { ...data, documents: Array.isArray(data.documents) ? data.documents : [], annualReports: Array.isArray(data.annualReports) ? data.annualReports : [] };
  if (key === 'financial-snapshot') return { ...S.SNAPSHOT_DEFAULTS, ...data };
  return data;
}

function useDocs(addToast) {
  const [docs, setDocs] = useState({});
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const ref = useRef(docs);
  ref.current = docs;
  const load = async (key) => {
    setDocs(d => ({ ...d, [key]: { ...(d[key] || {}), status: 'loading', error: null } }));
    const r = await readDoc(key);
    if (r.error) { setDocs(d => ({ ...d, [key]: { status: 'error', error: r.error } })); return; }
    const data = normalize(key, r.data);
    setDocs(d => ({ ...d, [key]: { status: 'ready', base: data, edit: data, sha: r.sha } }));
  };
  const ensure = (keys) => { for (const k of keys) if (!ref.current[k] || ref.current[k].status === 'error') load(k); };
  const update = (key, fn) => setDocs(d => (d[key]?.edit ? { ...d, [key]: { ...d[key], edit: fn(d[key].edit) } } : d));
  const set = (key, path, value) => update(key, e => S.setPath(e, path, value));
  const dirtyKeys = Object.keys(docs).filter(k => docs[k]?.edit && !S.same(docs[k].base, docs[k].edit));

  /** Save every changed document; returns true, or false with a toast or the conflict sheet */
  const save = async ({ keep = null } = {}) => {
    const keys = Object.keys(ref.current).filter(k => ref.current[k]?.edit && !S.same(ref.current[k].base, ref.current[k].edit));
    if (!keys.length || saving) return true;
    setSaving(true);
    const clashes = [];
    try {
      for (const key of keys) {
        const mine = ref.current[key];
        let done = false;
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          const fresh = await readDoc(key);
          if (fresh.error) { addToast(`Couldn't save: ${fresh.error}`, 'error'); return false; }
          const theirs = fresh.data || {};
          const { next, conflicts } = S.mergeForSave(mine.base, mine.edit, theirs);
          const open = conflicts.filter(p => !(keep?.[key] || []).includes(p));
          if (open.length) { clashes.push({ key, paths: open, theirs, mine: mine.edit, base: mine.base }); done = true; break; }
          const j = await call('/api/save-content', { path: S.docPath(key), content: JSON.stringify(next, null, 2), message: `Site Config: ${saveMessage(key, mine)}`, sha: fresh.sha || undefined });
          if (j.success) {
            const norm = normalize(key, next);
            // Typing during the save stays: it's laid onto what was saved
            setDocs(d => {
              const now = d[key];
              const edit = S.same(now.edit, mine.edit) ? norm : S.mergeForSave(mine.edit, now.edit, norm).next;
              return { ...d, [key]: { status: 'ready', base: norm, edit, sha: j.sha || null } };
            });
            done = true;
          } else if (j.status !== 409) {
            addToast(`Couldn't save: ${j.error || `HTTP ${j.status}`}`, 'error');
            return false;
          }
        }
        if (!done) { addToast('The page kept changing while saving. Try again.', 'error'); return false; }
      }
      if (clashes.length) { setConflict(clashes); return false; }
      window.dispatchEvent(new CustomEvent('soard-content-changed'));
      addToast('Saved', 'success');
      return true;
    } finally {
      setSaving(false);
    }
  };

  /** From the conflict sheet: for each clashing field, keep mine or take theirs, then save */
  const resolve = async (choices) => {
    const keep = {};
    for (const c of conflict || []) {
      const takeTheirs = c.paths.filter(p => choices[`${c.key}:${p}`] === 'theirs');
      keep[c.key] = c.paths.filter(p => choices[`${c.key}:${p}`] !== 'theirs');
      // Theirs: our edit at that field becomes theirs, so it isn't a change any more
      setDocs(d => {
        let edit = d[c.key].edit;
        let base = d[c.key].base;
        for (const p of takeTheirs) { edit = S.setPath(edit, p, S.clone(S.getPath(c.theirs, p))); base = S.setPath(base, p, S.clone(S.getPath(c.theirs, p))); }
        // Mine: start from theirs so the save writes over it knowingly
        for (const p of keep[c.key]) base = S.setPath(base, p, S.clone(S.getPath(c.theirs, p)));
        return { ...d, [c.key]: { ...d[c.key], edit, base } };
      });
    }
    setConflict(null);
    await new Promise(r => setTimeout(r, 0));
    return save({ keep });
  };

  const discard = (keys = null) => setDocs(d => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.edit && (!keys || keys.includes(k)) ? { ...v, edit: v.base } : v])));
  return { docs, ensure, load, update, set, save, saving, discard, dirtyKeys, conflict, resolve, cancelConflict: () => setConflict(null) };
}

/** "Homepage, Apply" for the audit message */
function saveMessage(key, d) {
  const names = [...new Set(S.changedPaths(d.base, d.edit).map(p => S.pageOf(key, p)?.title).filter(Boolean))];
  return names.length ? names.join(', ') : key;
}

// ─── Labels for changed fields (History, conflicts, the save bar) ─
const LABELS = {
  'homeHero.eyebrow': 'Hero: small line above the headline', 'homeHero.headlineLine1': 'Hero headline, line 1', 'homeHero.headlineLine2': 'Hero headline, line 2',
  'homeHero.lead': 'Hero paragraph', 'homeHero.cta1Label': 'Hero: first button', 'homeHero.cta1Link': 'Hero: first button link', 'homeHero.cta2Label': 'Hero: second button', 'homeHero.cta2Link': 'Hero: second button link',
  heroKidSlug: 'Hero kid', heroKidPhotoId: 'Hero photo', upNext: 'Up Next strip', featuredKidSlug: 'Featured Story kid', featuredStoryImage: 'Featured Story photo',
  featuredStoryHeadline: 'Featured Story headline', featuredStoryDescription: 'Featured Story paragraph', kidShowcase: 'Kid strip',
  kidsPageSummary: 'Line under the title', howItWorks: 'Featured project', applyTestimonial: 'Family quote', applyFaqs: 'Questions',
  partnerPhoto: 'Hero photo', partnerQuote: 'Partner quote', partnerQuoteName: 'Quote: name', partnerQuoteOrg: 'Quote: company',
  name: 'Organization name', shortName: 'Short name', tagline: 'Tagline', ein: 'EIN', phone: 'Phone', email: 'Email', address: 'Address', social: 'Social links', trustBadges: 'Trust badges',
  sunnyAndRanneyRooms: 'Room cards', milestones: 'Timeline', founders: 'How it began', turningPoint: 'The turning point', mascot: 'Gracie', store: 'The store', today: 'Where we are today', finale: 'Closing',
  documents: 'Tax returns, audits and other files', annualReports: 'Annual reports', categories: 'FAQ categories', items: 'Questions',
};
function labelOf(path) {
  const p = String(path).replace(/^photoTimestamps\./, '');
  if (LABELS[p]) return LABELS[p];
  if (S.PHOTO_SPECS[p]?.label) return `${S.PHOTO_SPECS[p].label}`;
  const top = p.split('.')[0];
  const parent = p.split('.').slice(0, 2).join('.');
  return LABELS[parent] || LABELS[top] || p.replace(/([A-Z])/g, ' $1').replace(/\./g, ' › ').replace(/^./, c => c.toUpperCase());
}
const valueText = (v) => (v == null || v === '' ? 'blank' : Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : typeof v === 'object' ? 'changed' : S.plainText(String(v)).slice(0, 90) || 'blank');

// ─── Building blocks ───────────────────────────────────────────────
class Portal extends Component {
  componentDidMount() { this.host = document.createElement('div'); document.body.append(this.host); this.paint(); }
  componentDidUpdate() { this.paint(); }
  componentWillUnmount() { render(null, this.host); this.host.remove(); }
  paint() { render(html`<div class="sc-root">${this.props.children}</div>`, this.host); }
  render() { return null; }
}

function Dialog({ title, sub = null, onClose, children, footer, wide = false, tall = false }) {
  const box = useRef(null);
  const id = useId('sc-dlg');
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    const raf = requestAnimationFrame(() => {
      const el = box.current?.querySelector('[data-autofocus]') || box.current?.querySelector('input:not([type="hidden"]):not([type="file"]), textarea, select') || box.current?.querySelector('.sc-dialog-foot .btn-primary, .sc-dialog-foot .btn');
      el?.focus();
    });
    const onKey = (e) => {
      if (!box.current) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current?.(); return; }
      if (e.key !== 'Tab') return;
      const all = [...box.current.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')].filter(x => x.offsetParent !== null);
      if (!all.length) return;
      const [a, z] = [all[0], all[all.length - 1]];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey, true); if (before?.isConnected) before.focus?.(); };
  }, []);
  return html`
    <${Portal}>
      <div class="modal-overlay sc-overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) close.current?.(); }}>
        <div class="modal sc-dialog ${wide ? 'is-wide' : ''} ${tall ? 'is-tall' : ''}" role="dialog" aria-modal="true" aria-labelledby=${id} ref=${box}>
          <div class="sc-dialog-head">
            <div><h3 id=${id}>${title}</h3>${sub && html`<p class="sc-sub">${sub}</p>`}</div>
            <button class="sc-icon-btn" aria-label="Close" onClick=${() => close.current?.()}><${Icon} name="close" /></button>
          </div>
          <div class="sc-dialog-body">${children}</div>
          ${footer && html`<div class="modal-buttons sc-dialog-foot">${footer}</div>`}
        </div>
      </div>
    <//>`;
}

/** A section of a page: a heading, what it is on the page, then its fields */
const Card = ({ title, sub, children, id = null, aside = null }) => html`
  <section class="card sc-card" id=${id}>
    <header class="sc-card-head">
      <div><h3>${title}</h3>${sub && html`<p class="sc-sub">${sub}</p>`}</div>
      ${aside}
    </header>
    ${children}
  </section>`;

/** Label, the control, then a problem or a hint */
function Field({ label, id, hint = null, problem = null, count = null, max = null, optional = false, children, wide = false }) {
  const over = max && count != null && count > max;
  return html`
    <div class="sc-field ${wide ? 'is-wide' : ''}">
      ${label && html`<label class="sc-label" for=${id} id=${`${id}-label`}>${label}${optional && html`<span class="sc-opt">optional</span>`}</label>`}
      ${children}
      ${(problem || hint || (max && count != null && count > max * 0.7)) && html`
        <div class="sc-under">
          ${problem ? html`<span class="sc-bad" role="alert">${problem}</span>` : hint ? html`<span class="sc-hint">${hint}</span>` : html`<span></span>`}
          ${max && count != null && count > max * 0.7 && html`<span class="sc-count ${over ? 'is-over' : ''}">${count}/${max}</span>`}
        </div>`}
    </div>`;
}

function TextField({ label, value, onChange, hint, placeholder = '', max = null, problem = null, type = 'text', optional = false, inputmode = null, wide = false, mono = false, list = null, autocomplete = null }) {
  const id = useId();
  const v = value ?? '';
  return html`
    <${Field} label=${label} id=${id} hint=${hint} problem=${problem} count=${String(v).length} max=${max} optional=${optional} wide=${wide}>
      <input id=${id} class="form-input ${mono ? 'sc-mono' : ''}" type=${type} inputmode=${inputmode} list=${list} autocomplete=${autocomplete} value=${v} placeholder=${placeholder} aria-invalid=${problem ? 'true' : 'false'}
        onInput=${(e) => onChange(e.target.value)} />
    <//>`;
}

function AreaField({ label, value, onChange, hint, placeholder = '', max = null, problem = null, rows = 3, optional = false }) {
  const id = useId();
  const ref = useRef(null);
  const v = value ?? '';
  // Grows with what's typed
  useEffect(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.max(el.scrollHeight + 2, rows * 24 + 20)}px`; }, [v]);
  return html`
    <${Field} label=${label} id=${id} hint=${hint} problem=${problem} count=${String(v).length} max=${max} optional=${optional} wide>
      <textarea id=${id} ref=${ref} class="form-input sc-area" rows=${rows} value=${v} placeholder=${placeholder} aria-invalid=${problem ? 'true' : 'false'} onInput=${(e) => onChange(e.target.value)}></textarea>
    <//>`;
}

function Segmented({ label, value, options, onChange }) {
  return html`
    <div class="sc-seg" role="radiogroup" aria-label=${label}>
      ${options.map(([k, text]) => html`<button type="button" role="radio" aria-checked=${value === k} class=${value === k ? 'is-on' : ''} onClick=${() => onChange(k)}>${text}</button>`)}
    </div>`;
}

// ─── Words with emphasis (contenteditable over the stored HTML) ────
const ALLOWED = { ALLOWED_TAGS: ['em', 'i', 'strong', 'b', 'a', 'br'], ALLOWED_ATTR: ['href', 'target', 'rel', 'class'] };
const cleanInline = (s) => DOMPurify.sanitize(String(s || ''), ALLOWED);
const escText = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The editable's DOM → the HTML the pages render: em (with the field's class when new), strong, links */
function serializeInline(root, { emClass = '' } = {}) {
  const walk = (n) => {
    if (n.nodeType === 3) return escText(n.nodeValue);
    if (n.nodeType !== 1) return '';
    const tag = n.tagName.toLowerCase();
    if (tag === 'br') return ' ';
    const inner = [...n.childNodes].map(walk).join('');
    if (!inner.trim()) return inner;
    if (tag === 'em' || tag === 'i') {
      const cls = tag === 'i' ? emClass : (n.getAttribute('class') || '');
      return `<em${cls ? ` class="${escAttr(cls)}"` : ''}>${inner}</em>`;
    }
    if (tag === 'strong' || tag === 'b') return `<strong>${inner}</strong>`;
    if (tag === 'a') {
      const href = n.getAttribute('href') || '';
      if (!href) return inner;
      const external = /^https?:/i.test(href);
      const target = n.getAttribute('target') || (external ? '_blank' : '');
      const rel = n.getAttribute('rel') || (target === '_blank' ? 'noopener' : '');
      return `<a href="${escAttr(href)}"${target ? ` target="${escAttr(target)}"` : ''}${rel ? ` rel="${escAttr(rel)}"` : ''}>${inner}</a>`;
    }
    return inner;
  };
  return [...root.childNodes].map(walk).join('').replace(/^[ \t\n]+|[ \t\n]+$/g, '').replace(/ {2,}/g, ' ');
}

/**
 * One line (or one paragraph) of text with emphasis. marks: 'em' (shows as the
 * site's highlight), 'strong', 'link'. Enter calls onEnter (a new paragraph)
 * instead of breaking the line.
 */
function InlineRich({ id: idIn = null, label = null, value, onChange, marks = ['em'], emClass = '', placeholder = '', onEnter = null, display = false, hint = null, problem = null, labelledBy = null }) {
  const auto = useId();
  const id = idIn || auto;
  const ref = useRef(null);
  const last = useRef(null);
  const [focus, setFocus] = useState(false);
  const [linking, setLinking] = useState(null);
  // What this box sent while being typed in: a render can arrive with an older one
  // of these after newer keys, and must not put that back over the newer text
  const sent = useRef(new Set());
  useEffect(() => {
    const el = ref.current;
    if (!el || value === last.current) return;
    if (document.activeElement === el && sent.current.has(value || '')) return;
    el.innerHTML = cleanInline(value || '');
    last.current = value || '';
  }, [value]);
  // Read the latest value through a ref: blur can come after a re-render, or after the box is gone
  const valueRef = useRef(value);
  valueRef.current = value;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const emit = () => { if (!ref.current) return; const out = serializeInline(ref.current, { emClass }); last.current = out; sent.current.add(out); if (out !== (valueRef.current || '')) changeRef.current(out); };
  const exec = (cmd, arg = null) => {
    try { document.execCommand('styleWithCSS', false, false); } catch { /* old browsers */ }
    document.execCommand(cmd, false, arg);
    emit();
  };
  const startLink = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !ref.current?.contains(sel.anchorNode)) return;
    const a = sel.anchorNode?.parentElement?.closest?.('a');
    setLinking({ range: sel.getRangeAt(0).cloneRange(), href: a?.getAttribute('href') || '' });
  };
  const applyLink = (href) => {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(linking.range);
    if (href) exec('createLink', href.trim()); else exec('unlink');
    setLinking(null);
    ref.current?.focus();
  };
  const onKeyDown = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'i' && marks.includes('em')) { e.preventDefault(); exec('italic'); }
    else if (mod && e.key.toLowerCase() === 'b' && marks.includes('strong')) { e.preventDefault(); exec('bold'); }
    else if (mod && e.key.toLowerCase() === 'k' && marks.includes('link')) { e.preventDefault(); startLink(); }
    else if (e.key === 'Enter') { e.preventDefault(); onEnter?.(); }
  };
  const onPaste = (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData?.getData('text/plain') || '').replace(/\s*\n\s*/g, ' '));
  };
  const tool = (name, text, title, fn) => html`<button type="button" class="sc-tool sc-tool-${name}" title=${title} aria-label=${title} onMouseDown=${(e) => { e.preventDefault(); fn(); }}>${text}</button>`;
  return html`
    <div class="sc-field is-wide">
      ${label && html`<span class="sc-label" id=${`${id}-label`}>${label}</span>`}
      <div class="sc-rich ${display ? 'is-display' : ''} ${focus ? 'is-focus' : ''} ${problem ? 'is-bad' : ''}">
        <div id=${id} ref=${ref} class="sc-rich-text form-input" contenteditable="true" role="textbox" aria-multiline="false"
          aria-labelledby=${labelledBy || (label ? `${id}-label` : null)} data-placeholder=${placeholder} spellcheck="true"
          onInput=${emit} onBlur=${() => { emit(); sent.current.clear(); setFocus(false); }} onFocus=${() => setFocus(true)} onKeyDown=${onKeyDown} onPaste=${onPaste}></div>
        ${marks.length > 0 && html`
          <div class="sc-tools" aria-label="Formatting">
            ${marks.includes('em') && tool('em', html`<em>Aa</em>`, `Highlight (${MOD}I)`, () => exec('italic'))}
            ${marks.includes('strong') && tool('strong', html`<b>B</b>`, `Bold (${MOD}B)`, () => exec('bold'))}
            ${marks.includes('link') && tool('link', html`<${Icon} name="link" size=${14} />`, `Link (${MOD}K)`, startLink)}
          </div>`}
      </div>
      ${linking && html`<${LinkBar} href=${linking.href} onApply=${applyLink} onCancel=${() => { setLinking(null); ref.current?.focus(); }} />`}
      ${(problem || hint) && html`<div class="sc-under">${problem ? html`<span class="sc-bad" role="alert">${problem}</span>` : html`<span class="sc-hint">${hint}</span>`}</div>`}
    </div>`;
}

function LinkBar({ href, onApply, onCancel }) {
  const [v, setV] = useState(href || '');
  const problem = S.linkProblem(v);
  return html`
    <div class="sc-linkbar" role="group" aria-label="Link">
      <input class="form-input" data-autofocus value=${v} placeholder="/donate/ or https://…" aria-label="Link to"
        ref=${(el) => el && requestAnimationFrame(() => el.focus())}
        onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!problem) onApply(v); } if (e.key === 'Escape') { e.preventDefault(); onCancel(); } }} />
      <button type="button" class="btn btn-primary btn-sm" disabled=${!v.trim() || !!problem} onClick=${() => onApply(v)}>Link</button>
      ${href && html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => onApply('')}>Remove link</button>`}
      <button type="button" class="btn btn-ghost btn-sm" onClick=${onCancel}>Cancel</button>
      ${v && problem && html`<span class="sc-bad">${problem}</span>`}
    </div>`;
}

/** Several paragraphs, each with emphasis; Enter starts the next one */
function Paragraphs({ label, value = [], onChange, marks = ['em', 'strong', 'link'], emClass = 'highlight', hint = null }) {
  const id = useId();
  const list = Array.isArray(value) ? value : [];
  const keys = useRef([]);
  while (keys.current.length < list.length) keys.current.push(`p${++uid}`);
  keys.current.length = list.length;
  const focusAt = (i) => requestAnimationFrame(() => document.querySelectorAll(`[data-paras="${id}"] .sc-rich-text`)[i]?.focus());
  const insert = (i) => { keys.current.splice(i + 1, 0, `p${++uid}`); onChange([...list.slice(0, i + 1), '', ...list.slice(i + 1)]); focusAt(i + 1); };
  const remove = (i) => { keys.current.splice(i, 1); onChange(list.filter((_, j) => j !== i)); };
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= list.length) return; const n = [...list]; [n[i], n[j]] = [n[j], n[i]]; const k = keys.current; [k[i], k[j]] = [k[j], k[i]]; onChange(n); };
  return html`
    <div class="sc-field is-wide">
      <span class="sc-label" id=${`${id}-label`}>${label}</span>
      <div class="sc-paras" data-paras=${id}>
        ${list.map((p, i) => html`
          <div class="sc-para" key=${keys.current[i]}>
            <span class="sc-para-n" aria-hidden="true">${i + 1}</span>
            <${InlineRich} value=${p} marks=${marks} emClass=${emClass} labelledBy=${`${id}-label`} placeholder="Write a paragraph" onChange=${(v) => onChange(list.map((x, j) => (j === i ? v : x)))} onEnter=${() => insert(i)} />
            <div class="sc-para-tools">
              <button type="button" class="sc-icon-btn" disabled=${i === 0} aria-label=${`Move paragraph ${i + 1} up`} onClick=${() => move(i, -1)}><${Icon} name="up" size=${14} /></button>
              <button type="button" class="sc-icon-btn" disabled=${i === list.length - 1} aria-label=${`Move paragraph ${i + 1} down`} onClick=${() => move(i, 1)}><${Icon} name="down" size=${14} /></button>
              <button type="button" class="sc-icon-btn" aria-label=${`Remove paragraph ${i + 1}`} onClick=${() => remove(i)}><${Icon} name="trash" size=${14} /></button>
            </div>
          </div>`)}
      </div>
      <div class="sc-under"><span class="sc-hint">${hint || `Enter at the end of a paragraph starts the next. ${MOD}I highlights, ${MOD}B bolds${marks.includes('link') ? `, ${MOD}K links` : ''}.`}</span></div>
      <button type="button" class="btn btn-ghost btn-sm sc-add" onClick=${() => insert(list.length - 1)}><${Icon} name="plus" size=${14} /> Add a paragraph</button>
    </div>`;
}

// ─── Lists (drag, keyboard, buttons) ───────────────────────────────
/**
 * Reorderable rows. Drag by the handle, or Alt+↑/↓ from inside a row, or the
 * arrow buttons. Remove offers Undo. `items` keep their own identity through
 * `keyOf` (or a key made once per row).
 */
function ListEditor({ items = [], onChange, renderItem, make = null, addLabel = 'Add', max = null, keyOf = null, empty = null, addDisabled = false, label = 'item', addToast = null, onAdd = null, canRemove = null }) {
  const ref = useRef(null);
  const keys = useRef([]);
  if (!keyOf) {
    while (keys.current.length < items.length) keys.current.push(`r${++uid}`);
    keys.current.length = items.length;
  }
  const keyAt = (it, i) => (keyOf ? keyOf(it, i) : keys.current[i]);
  const latest = useRef({ items, onChange });
  latest.current = { items, onChange };
  const move = (from, to) => {
    const { items: list, onChange: set } = latest.current;
    if (to < 0 || to >= list.length || from === to) return;
    const n = [...list];
    const [x] = n.splice(from, 1);
    n.splice(to, 0, x);
    if (!keyOf) { const k = keys.current; const [y] = k.splice(from, 1); k.splice(to, 0, y); }
    set(n);
  };
  useEffect(() => {
    if (!ref.current || !Sortable) return undefined;
    const s = Sortable.create(ref.current, {
      handle: '.sc-grip', animation: prefersReducedMotion() ? 0 : 150, forceFallback: true, fallbackOnBody: true, fallbackTolerance: 3,
      ghostClass: 'sc-ghost', chosenClass: 'sc-chosen',
      onEnd: (evt) => {
        const { item, from, oldIndex, newIndex } = evt;
        if (oldIndex === newIndex) return;
        item.remove();
        from.insertBefore(item, from.children[oldIndex] || null);
        move(oldIndex, newIndex);
      },
    });
    return () => s.destroy();
  }, []);
  const remove = (i) => {
    const { items: list, onChange: set } = latest.current;
    const gone = list[i];
    if (!keyOf) keys.current.splice(i, 1);
    set(list.filter((_, j) => j !== i));
    addToast?.(`Removed the ${label}.`, 'info', { label: 'Undo', fn: () => { const cur = latest.current.items; if (!keyOf) keys.current.splice(i, 0, `r${++uid}`); latest.current.onChange([...cur.slice(0, i), gone, ...cur.slice(i)]); } });
  };
  const onKey = (e, i) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const to = i + (e.key === 'ArrowUp' ? -1 : 1);
    move(i, to);
    requestAnimationFrame(() => ref.current?.children[to]?.querySelector('.sc-grip')?.focus());
  };
  const full = max != null && items.length >= max;
  return html`
    <div class="sc-list-wrap">
      <ol class="sc-list" ref=${ref}>
        ${items.map((it, i) => html`
          <li class="sc-row" key=${keyAt(it, i)} onKeyDown=${(e) => onKey(e, i)}>
            <button type="button" class="sc-grip" aria-label=${`Move ${label} ${i + 1}. Alt+arrow keys move it.`} title="Drag, or Alt+↑/↓"><${Icon} name="grip" /></button>
            <div class="sc-row-body">${renderItem(it, i, (patch) => onChange(items.map((x, j) => (j === i ? (typeof patch === 'function' ? patch(x) : { ...x, ...patch }) : x))))}</div>
            <div class="sc-row-tools">
              <button type="button" class="sc-icon-btn" disabled=${i === 0} aria-label=${`Move ${label} ${i + 1} up`} onClick=${() => move(i, i - 1)}><${Icon} name="up" size=${14} /></button>
              <button type="button" class="sc-icon-btn" disabled=${i === items.length - 1} aria-label=${`Move ${label} ${i + 1} down`} onClick=${() => move(i, i + 1)}><${Icon} name="down" size=${14} /></button>
              <button type="button" class="sc-icon-btn sc-remove" aria-label=${`Remove ${label} ${i + 1}`} disabled=${!!canRemove?.(it)} title=${canRemove?.(it) || ''} onClick=${() => remove(i)}><${Icon} name="trash" size=${14} /></button>
            </div>
          </li>`)}
      </ol>
      ${!items.length && empty && html`<div class="sc-empty">${empty}</div>`}
      ${(make || onAdd) && html`
        <button type="button" class="btn btn-ghost btn-sm sc-add" disabled=${full || addDisabled} onClick=${() => (onAdd ? onAdd() : onChange([...items, make()]))}>
          <${Icon} name="plus" size=${14} /> ${addLabel}${full ? ` (up to ${max})` : ''}
        </button>`}
    </div>`;
}

// ─── Kids ──────────────────────────────────────────────────────────
const STATUS_TEXT = { completed: 'Completed', 'in-progress': 'Building now', upcoming: 'Coming up', funding: 'Awaiting funding' };
const kidThumb = (k, size = 80) => imgUrl(k?.heroImage || (k?.slug ? `kids/${k.slug}/hero` : ''), `w=${size},h=${size},fit=cover,gravity=face,q=70`);

/**
 * Pick a kid: a button showing who's picked, a searchable list under it.
 * Only kids the site shows (drafts are left out there, so not offered here).
 */
function KidPicker({ label, value, onChange, kids = [], filter = null, blankLabel = null, hint = null, describe = null, problem = null }) {
  const id = useId('sc-kid');
  const [open, setOpen] = useState(false);
  // Drawn over everything and pinned to its button (./float.js); a bottom sheet on phones
  const popRef = useMemo(() => floatRef({ align: 'stretch', sheet: '(max-width: 640px)', onHide: () => setOpen(false) }), []);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const wrap = useRef(null);
  const all = useMemo(() => S.publishedKids(kids).filter(k => !filter || filter(k)).sort((a, b) => (b.year || 0) - (a.year || 0) || String(a.name).localeCompare(String(b.name))), [kids, filter]);
  const current = kids.find(k => k.slug === value) || null;
  const words = q.trim().toLowerCase();
  const list = all.filter(k => !words || `${k.name} ${k.year} ${k.diagnosis || ''} ${STATUS_TEXT[k.status] || ''}`.toLowerCase().includes(words));
  const options = blankLabel && !words ? [{ slug: '', blank: true }, ...list] : list;
  useEffect(() => {
    if (!open) return undefined;
    const out = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', out);
    return () => document.removeEventListener('mousedown', out);
  }, [open]);
  useEffect(() => { if (open) setActive(Math.max(0, options.findIndex(o => o.slug === (value || '')))); }, [open, q]);
  const pick = (slug) => { setOpen(false); setQ(''); if (slug !== (value || '')) onChange(slug); requestAnimationFrame(() => wrap.current?.querySelector('.sc-kid-btn')?.focus()); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options[active]) pick(options[active].slug); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); wrap.current?.querySelector('.sc-kid-btn')?.focus(); }
  };
  useEffect(() => { wrap.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const draft = current && current.publishStatus === 'draft';
  return html`
    <div class="sc-field">
      ${label && html`<span class="sc-label" id=${`${id}-label`}>${label}</span>`}
      <div class="sc-kid" ref=${wrap}>
        <button type="button" class="sc-kid-btn form-input" aria-haspopup="listbox" aria-expanded=${open} aria-labelledby=${label ? `${id}-label ${id}-now` : null} onClick=${() => setOpen(o => !o)}>
          ${current
            ? html`<img class="sc-avatar" src=${kidThumb(current)} alt="" /><span id=${`${id}-now`} class="sc-kid-name">${S.kidLabel(current)}</span>${STATUS_TEXT[current.status] && html`<span class="sc-chip">${STATUS_TEXT[current.status]}</span>`}`
            : html`<span class="sc-avatar is-blank" aria-hidden="true"></span><span id=${`${id}-now`} class="sc-kid-name ${value ? 'sc-bad' : 'sc-muted'}">${value ? `“${value}” isn’t a kid on the site` : blankLabel || 'Pick a kid'}</span>`}
          <${Icon} name="chevron" />
        </button>
        ${open && html`
          <div class="sc-pop" role="dialog" aria-label=${label || 'Pick a kid'} ref=${popRef}>
            <label class="sc-search"><${Icon} name="search" />
              <input value=${q} placeholder="Search kids" aria-label="Search kids" aria-controls=${`${id}-list`} aria-activedescendant=${options[active] ? `${id}-o${active}` : null}
                ref=${(el) => el && !el.dataset.f && (el.dataset.f = '1', requestAnimationFrame(() => el.focus()))} onInput=${(e) => setQ(e.target.value)} onKeyDown=${onKey} />
            </label>
            <ul class="sc-options" role="listbox" id=${`${id}-list`} aria-label="Kids">
              ${options.map((k, i) => html`
                <li role="option" id=${`${id}-o${i}`} data-i=${i} aria-selected=${(value || '') === k.slug} class=${i === active ? 'is-active' : ''}
                  onMouseEnter=${() => setActive(i)} onMouseDown=${(e) => { e.preventDefault(); pick(k.slug); }}>
                  ${k.blank
                    ? html`<span class="sc-avatar is-blank" aria-hidden="true"></span><span class="sc-opt-main"><span>${blankLabel}</span></span>`
                    : html`<img class="sc-avatar" src=${kidThumb(k)} alt="" loading="lazy" /><span class="sc-opt-main"><span>${S.kidLabel(k)}</span><span class="sc-hint">${[STATUS_TEXT[k.status], describe?.(k)].filter(Boolean).join(' · ')}</span></span>`}
                  ${(value || '') === k.slug && html`<${Icon} name="check" />`}
                </li>`)}
              ${!options.length && html`<li class="sc-none" role="presentation">No kid matches “${q}”.</li>`}
            </ul>
          </div>`}
      </div>
      <div class="sc-under">
        ${problem ? html`<span class="sc-bad" role="alert">${problem}</span>` : draft ? html`<span class="sc-bad">${current.name} is a draft, so the site doesn’t show them. Pick someone else.</span>` : hint ? html`<span class="sc-hint">${hint}</span>` : null}
      </div>
    </div>`;
}

// ─── Photos ────────────────────────────────────────────────────────
const RATIO_TEXT = [[4 / 5, '4:5, portrait'], [5 / 6, '5:6, portrait'], [4 / 3, '4:3, landscape'], [3 / 2, '3:2, landscape'], [6 / 5, '6:5'], [10 / 7, '10:7, landscape'], [5 / 4, '5:4'], [1, 'square'], [480 / 280, '12:7, wide']];
const ratioText = (r) => (RATIO_TEXT.find(([v]) => Math.abs(v - r) < 0.01)?.[1] || `${Math.round(r * 100) / 100}:1`);

/** "Dex’s photos", "Our Story", "Badges"… where an image came from */
function sourceText(id, kids = []) {
  if (!id) return '';
  const slug = S.kidSlugOfImage(id);
  if (slug) { const k = kids.find(x => x.slug === slug); return k ? `From ${k.name}’s photos` : `From the ${slug} folder`; }
  const top = id.split('/')[0];
  return id.includes('/') ? `From the ${top.replace(/-/g, ' ')} folder` : 'From the image library';
}

/**
 * A photo as the page crops it (the same Cloudflare transform), what it's
 * used for, and Change / back to the built-in one.
 */
function PhotoField({ path, value, onChange, spec: specIn = null, label: labelIn = null, kids = [], kidSlug = null, stamp = null, uploadPrefix = 'kids', optional = false, compact = false, fallback: fallbackIn = undefined, borrows = null }) {
  const spec = specIn || S.PHOTO_SPECS[path] || {};
  const label = labelIn || spec.label || 'Photo';
  // `borrows`: a blank one shows another photo ("the small inset photo"); otherwise the page's built-in one
  const fallback = fallbackIn !== undefined ? fallbackIn : spec.fallback;
  const builtIn = borrows ? `Same as ${spec.blankShows || 'another photo'}` : 'Built in';
  const [picking, setPicking] = useState(false);
  const id = S.cfIdOf(value);
  const showing = id || S.cfIdOf(fallback || '');
  const src = imgUrl(showing, spec.ratio && spec.crop ? S.cropTransforms(spec, compact ? 360 : 640) : `w=${compact ? 360 : 640},q=75`);
  const age = daysAgo(stamp);
  return html`
    <div class="sc-photo ${compact ? 'is-compact' : ''}" data-photo=${path}>
      <button type="button" class="sc-photo-frame ${spec.ratio ? '' : 'is-whole'}" style=${spec.ratio ? `aspect-ratio:${spec.ratio}` : ''} onClick=${() => setPicking(true)} aria-label=${`Change the ${label.toLowerCase()}`}>
        ${src
          ? html`<img src=${src} alt="" loading="lazy" decoding="async" style=${spec.position ? `object-position:${spec.position}` : ''} />`
          : html`<span class="sc-photo-none"><${Icon} name="image" size=${22} /><span>${spec.blankShows ? `Shows ${spec.blankShows}` : 'No photo'}</span></span>`}
        ${!id && src && html`<span class="sc-photo-tag">${builtIn}</span>`}
        <span class="sc-photo-change" aria-hidden="true">Change</span>
      </button>
      <div class="sc-photo-meta">
        <strong class="sc-photo-label">${label}</strong>
        ${spec.where && html`<span class="sc-hint">${spec.where}</span>`}
        <span class="sc-photo-from" title=${id || ''}>${id ? sourceText(id, kids) : borrows ? `Blank, so it shows ${spec.blankShows}` : fallback ? 'The built-in photo' : spec.blankShows ? `Blank: shows ${spec.blankShows}` : 'No photo yet'}</span>
        <span class="sc-hint">${spec.ratio ? `Cropped ${ratioText(spec.ratio)}${spec.crop === 'face' ? ', around faces' : ''}` : 'Shown whole, never cropped'}</span>
        ${spec.also && html`<span class="sc-hint">${spec.also}</span>`}
        ${age != null && age > 120 && html`<span class="sc-chip is-warn" title="Swap in a newer photo when you can">Chosen ${age} days ago</span>`}
        <div class="sc-photo-actions">
          <button type="button" class="btn btn-ghost btn-sm" onClick=${() => setPicking(true)}>Change…</button>
          ${id && (fallback || spec.blankShows || optional) && html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => onChange('')}>${borrows ? `Use ${spec.blankShows}` : fallback ? 'Use the built-in photo' : spec.blankShows ? 'Clear' : 'Remove'}</button>`}
        </div>
      </div>
      ${picking && html`<${PhotoPicker} title=${`Choose the ${label.toLowerCase()}`} spec=${spec} value=${id} kids=${kids} kidSlug=${kidSlug} uploadPrefix=${uploadPrefix}
        onPick=${(v) => { setPicking(false); if (v !== id) onChange(v); }} onClose=${() => setPicking(false)} />`}
    </div>`;
}

const theKidName = (kids, slug) => kids.find(k => k.slug === slug)?.name || slug;
let libraryCache = null;
async function loadLibrary(force = false) {
  if (libraryCache && !force) return libraryCache;
  let all = [];
  let token = '';
  do {
    const j = await call(`/api/list-images?per_page=10000${token ? `&continuation_token=${encodeURIComponent(token)}` : ''}`);
    if (!j.success) throw new Error(j.error || 'Could not list the images');
    all = all.concat(j.images || []);
    token = j.continuation_token || '';
  } while (token && all.length < 60000);
  libraryCache = all.map(x => ({ id: x.id, at: x.uploaded || '' })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return libraryCache;
}

/** Kids' photos by kid, the whole library, or an upload; the crop shows before you choose */
function PhotoPicker({ title, spec = {}, value = '', kids = [], kidSlug = null, uploadPrefix = 'kids', onPick, onClose }) {
  const kidList = useMemo(() => S.publishedKids(kids).filter(k => S.kidPhotos(k).length).sort((a, b) => (b.year || 0) - (a.year || 0) || String(a.name).localeCompare(String(b.name))), [kids]);
  const fromValue = S.kidSlugOfImage(value);
  const [tab, setTab] = useState(uploadPrefix !== 'kids' && !fromValue && !kidSlug ? 'library' : 'kids');
  const [kid, setKid] = useState(kidSlug || fromValue || kidList[0]?.slug || '');
  const [kq, setKq] = useState('');
  const [sel, setSel] = useState(value || '');
  const [lib, setLib] = useState(libraryCache);
  const [libErr, setLibErr] = useState(null);
  const [lq, setLq] = useState('');
  const [folder, setFolder] = useState('');
  const [shown, setShown] = useState(60);
  const [busy, setBusy] = useState(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => { if (tab === 'library' && !lib) loadLibrary().then(setLib).catch(e => setLibErr(e.message)); }, [tab]);
  const kidsShown = kidList.filter(k => !kq.trim() || `${k.name} ${k.year}`.toLowerCase().includes(kq.trim().toLowerCase()));
  const theKid = kids.find(k => k.slug === kid);
  const kidPics = S.kidPhotos(theKid);
  const folders = useMemo(() => {
    if (!lib) return [];
    const n = new Map();
    for (const x of lib) { const f = x.id.includes('/') ? x.id.split('/')[0] : ''; if (f) n.set(f, (n.get(f) || 0) + 1); }
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [lib]);
  const libShown = (lib || []).filter(x => (!folder || x.id.startsWith(`${folder}/`)) && (!lq.trim() || x.id.toLowerCase().includes(lq.trim().toLowerCase())));
  const upload = async (files) => {
    const list = [...(files || [])].filter(f => /^image\//.test(f.type));
    if (!list.length) return;
    const prefix = kidSlug ? `kids/${kidSlug}` : uploadPrefix;
    let last = null;
    for (const [i, f] of list.entries()) {
      setBusy(`Uploading ${i + 1} of ${list.length}…`);
      if (f.size > 10 * 1024 * 1024) { setBusy(null); setLibErr(`${f.name} is over 10 MB.`); return; }
      const fd = new FormData();
      fd.append('file', f);
      fd.append('id', `${prefix}/${Date.now()}-${f.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60)}`);
      const j = await call('/api/upload-image', fd);
      if (!j.success) { setBusy(null); setLibErr(`Couldn't upload ${f.name}: ${j.error}`); return; }
      last = j.imageId;
      if (libraryCache) libraryCache = [{ id: j.imageId, at: new Date().toISOString() }, ...libraryCache];
    }
    setBusy(null);
    setLib(libraryCache);
    if (last) { setSel(last); setTab('library'); setFolder(''); setLq(''); }
  };
  const tile = (id, alt = '') => html`
    <button type="button" class="sc-tile ${sel === id ? 'is-sel' : ''}" aria-pressed=${sel === id} title=${alt || id}
      onClick=${() => setSel(id)} onDblClick=${() => onPick(id)}>
      <img src=${imgUrl(id, 'w=320,h=320,fit=cover,gravity=auto,q=70')} alt=${alt} loading="lazy" decoding="async" />
      ${sel === id && html`<span class="sc-tile-check"><${Icon} name="check" size=${14} /></span>`}
      ${id === value && html`<span class="sc-tile-now">Now</span>`}
    </button>`;
  return html`
    <${Dialog} title=${title} wide tall onClose=${onClose}
      footer=${html`
        <div class="sc-pick-preview">
          ${sel ? html`<span class="sc-pick-crop" style=${spec.ratio ? `aspect-ratio:${spec.ratio}` : ''}><img src=${imgUrl(sel, spec.ratio && spec.crop ? S.cropTransforms(spec, 240) : 'w=240,q=70')} alt="" style=${spec.position ? `object-position:${spec.position}` : ''} /></span>` : null}
          <span class="sc-hint">${sel ? (spec.ratio ? `As the page crops it (${ratioText(spec.ratio)})` : 'Shown whole on the page') : 'Pick a photo'}</span>
        </div>
        <button type="button" class="btn btn-ghost" onClick=${onClose}>Cancel</button>
        <button type="button" class="btn btn-primary" disabled=${!sel} onClick=${() => onPick(sel)}>Use this photo</button>`}>
      <div class="sc-tabs" role="tablist" aria-label="Where from">
        ${[['kids', 'Kids’ photos'], ['library', 'All images'], ['upload', 'Upload']].map(([k, t]) => html`
          <button type="button" role="tab" aria-selected=${tab === k} class=${tab === k ? 'is-on' : ''} onClick=${() => setTab(k)}>${t}</button>`)}
      </div>
      ${tab === 'kids' && html`
        <div class="sc-pick-kids">
          <div class="sc-pick-side">
            <label class="sc-search"><${Icon} name="search" /><input value=${kq} placeholder="Search kids" aria-label="Search kids" onInput=${(e) => setKq(e.target.value)} /></label>
            <ul class="sc-pick-kidlist" aria-label="Kids">
              ${kidsShown.map(k => html`
                <li><button type="button" class=${k.slug === kid ? 'is-on' : ''} aria-current=${k.slug === kid} onClick=${() => setKid(k.slug)}>
                  <img class="sc-avatar" src=${kidThumb(k, 64)} alt="" loading="lazy" /><span>${S.kidLabel(k)}</span><span class="sc-count">${S.kidPhotos(k).length}</span>
                </button></li>`)}
            </ul>
          </div>
          <div class="sc-pick-grid" aria-label=${theKid ? `${theKid.name}’s photos` : 'Photos'}>
            ${kidPics.map(p => tile(p.id, p.alt))}
            ${!kidPics.length && html`<p class="sc-empty">No photos for this kid yet.</p>`}
          </div>
        </div>`}
      ${tab === 'library' && html`
        <div class="sc-pick-lib">
          <div class="sc-pick-filters">
            <label class="sc-search"><${Icon} name="search" /><input value=${lq} placeholder="Search by name" aria-label="Search images" onInput=${(e) => { setLq(e.target.value); setShown(60); }} /></label>
            <div class="sc-chips">
              <button type="button" class=${!folder ? 'is-on' : ''} onClick=${() => { setFolder(''); setShown(60); }}>Newest</button>
              ${folders.map(([f, n]) => html`<button type="button" class=${folder === f ? 'is-on' : ''} onClick=${() => { setFolder(f); setShown(60); }}>${f.replace(/-/g, ' ')} <span class="sc-count">${n}</span></button>`)}
            </div>
          </div>
          ${libErr && html`<p class="sc-bad">${libErr}</p>`}
          ${!lib && !libErr && html`<div class="sc-spin"><span class="spinner" /></div>`}
          ${lib && html`
            <div class="sc-pick-grid">${libShown.slice(0, shown).map(x => tile(x.id))}</div>
            ${libShown.length > shown && html`<button type="button" class="btn btn-ghost sc-more" onClick=${() => setShown(n => n + 60)}>Show more (${libShown.length - shown} left)</button>`}
            ${!libShown.length && html`<p class="sc-empty">Nothing matches.</p>`}`}
        </div>`}
      ${tab === 'upload' && html`
        <div class="sc-drop ${drag ? 'is-over' : ''}" onDragOver=${(e) => { e.preventDefault(); setDrag(true); }} onDragLeave=${() => setDrag(false)}
          onDrop=${(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer?.files); }}>
          <${Icon} name="upload" size=${28} />
          <p><strong>Drop photos here</strong> or</p>
          <button type="button" class="btn btn-primary" disabled=${!!busy} onClick=${() => fileRef.current?.click()}>${busy || 'Choose photos'}</button>
          <input ref=${fileRef} type="file" accept="image/*" multiple hidden onChange=${(e) => { const f = e.target.files; upload(f); e.target.value = ''; }} />
          <p class="sc-hint">JPG, PNG or WebP, up to 10 MB each. They go into the image library${kidSlug ? ` with ${theKidName(kids, kidSlug)}’s photos` : ''}, and the last one is picked.</p>
          ${libErr && html`<p class="sc-bad">${libErr}</p>`}
        </div>`}
    <//>`;
}

// ─── Pages ─────────────────────────────────────────────────────────
// Each page gets `c`: c.doc(key) the document as edited, c.set(key, path, v),
// c.update(key, fn), c.photo(path, v) (a settings photo, with its date), the
// kids, and c.go(pageKey, anchor) / c.open(view, hash) to move around.

const heroIdOf = (kids, slug) => S.cfIdOf(kids.find(k => k.slug === slug)?.heroImage || '') || (slug ? `kids/${slug}/hero` : '');
/** "Reveal mid November", "Reveal Tuesday, November 25", or "Reveal coming soon" (the site's own wording, src/utils/reveals-client.ts) */
const revealDateLine = (r) => !r ? 'Reveal coming soon'
  : r.confirmed ? `Reveal ${new Date(`${r.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}`
  : `Reveal ${r.window?.label || 'coming soon'}`;
/** Upcoming reveals from the public feed (null while loading, [] if it can't be read) */
function useUpcomingReveals() {
  const [list, setList] = useState(null);
  useEffect(() => {
    let on = true;
    fetch('/api/reveals', { headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : {}))
      .then(b => { if (on) setList(Array.isArray(b.upcoming) ? b.upcoming : []); })
      .catch(() => { if (on) setList([]); });
    return () => { on = false; };
  }, []);
  return list;
}
const roomsText = (k) => { const r = (k?.roomTypes || []).map(x => String(x).toLowerCase()); return r.length > 1 ? `${r.slice(0, -1).join(', ')} and ${r[r.length - 1]}` : (r[0] || 'dream room'); };
const photoProps = (c, path, extra = {}) => ({ path, value: S.getPath(c.doc('settings'), path) || '', onChange: (v) => c.photo(path, v), kids: c.kids, stamp: c.doc('settings')?.photoTimestamps?.[path] || null, ...extra });
const Photos = ({ children, cols = null }) => html`<div class="sc-photos ${cols ? `cols-${cols}` : ''}">${children}</div>`;

function HomePage({ c }) {
  const st = c.doc('settings');
  const hero = st.homeHero || {};
  const setHero = (k) => (v) => c.set('settings', `homeHero.${k}`, v);
  const featuredSlug = st.featuredKidSlug || 'zyah';
  const featured = c.kids.find(k => k.slug === featuredSlug);
  const heroSlug = st.heroKidSlug || featuredSlug;
  const up = st.upNext || {};
  const mode = up.mode || 'auto';
  const setUp = (k) => (v) => c.set('settings', `upNext.${k}`, v);
  const building = S.publishedKids(c.kids).filter(k => k.status === 'in-progress').sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || String(a.name).localeCompare(String(b.name)));
  // The site picks the build whose reveal is next in JobTread and dates the strip from it (src/pages/index.astro)
  const upcoming = useUpcomingReveals();
  const nextUp = (upcoming || []).map(r => building.find(k => k.slug === r.slug)).find(Boolean);
  const nowBuilding = (up.kidSlug && building.find(k => k.slug === up.kidSlug)) || nextUp || building[0];
  const nowReveal = nowBuilding && (upcoming || []).find(r => r.slug === nowBuilding.slug);
  const autoDate = upcoming === null ? '' : revealDateLine(nowReveal);
  const strip = Array.isArray(st.kidShowcase) ? st.kidShowcase : [];
  const [adding, setAdding] = useState(false);
  const snap = c.doc('financial-snapshot');
  const fdName = featured?.name || 'Zyah';
  const autoHeadline = `${fdName}'s new space gave them independence, and their family peace of mind.`;
  const autoText = `${fdName}, ${kidAgeText(featured)}, lives with ${featured?.diagnosis || 'Spinal Muscular Atrophy'}. Our team transformed their space into an accessible, joyful haven with custom features designed around their unique needs and personality.`;
  return html`
    <${Card} id="sc-hero" title="Hero" sub="The top of the homepage, the first thing everyone sees.">
      <div class="sc-split">
        <div class="sc-stack">
          <${TextField} label="Small line above the headline" value=${hero.eyebrow} onChange=${setHero('eyebrow')} placeholder="501(c)(3) Nonprofit · Atlanta, GA · Since 2012" max=${70} />
          <${InlineRich} label="Headline, first line" value=${hero.headlineLine1} onChange=${setHero('headlineLine1')} placeholder="Building dreams," display />
          <${InlineRich} label="Headline, second line" value=${hero.headlineLine2} onChange=${setHero('headlineLine2')} placeholder="one room at a time" display hint=${`${MOD}I puts a word in the yellow marker.`} />
          <${InlineRich} label="Paragraph" value=${hero.lead} onChange=${setHero('lead')} marks=${['em', 'strong']} placeholder="Dream bedrooms, accessible bathrooms, and therapy rooms for children with special needs, at no cost to families." />
          <div class="sc-pair">
            <${TextField} label="First button" value=${hero.cta1Label} onChange=${setHero('cta1Label')} placeholder="Give Today" max=${24} />
            <${TextField} label="Goes to" value=${hero.cta1Link} onChange=${setHero('cta1Link')} placeholder="/donate/" problem=${S.linkProblem(hero.cta1Link)} inputmode="url" />
          </div>
          <div class="sc-pair">
            <${TextField} label="Second button" value=${hero.cta2Label} onChange=${setHero('cta2Label')} placeholder="See Our Work" max=${24}
              hint=${S.endsWithArrow(hero.cta2Label) ? html`The button draws its own arrow, so the one typed here is left off. <button type="button" class="sc-link" onClick=${() => setHero('cta2Label')(S.withoutArrow(hero.cta2Label))}>Remove it</button>` : 'The button adds a down arrow.'} />
            <${TextField} label="Goes to" value=${hero.cta2Link} onChange=${setHero('cta2Link')} placeholder="#stories" problem=${S.linkProblem(hero.cta2Link)} inputmode="url" />
          </div>
        </div>
        <div class="sc-stack">
          <${KidPicker} label="Who’s in the hero photo" value=${st.heroKidSlug || ''} kids=${c.kids} blankLabel=${`Same as the Featured Story (${fdName})`}
            hint="Their page is where the photo links."
            onChange=${(slug) => c.update('settings', (e) => S.withPhoto(S.setPath(e, 'heroKidSlug', slug), 'heroKidPhotoId', heroIdOf(c.kids, slug || featuredSlug)))} />
          <${PhotoField} ...${photoProps(c, 'heroKidPhotoId', { kidSlug: heroSlug, fallback: heroIdOf(c.kids, heroSlug) })} />
        </div>
      </div>
      <${HeroPreview} hero=${hero} />
    <//>

    <${Card} id="sc-upnext" title="Up Next strip" sub="The announcement card right under the hero.">
      <${Segmented} label="What the strip shows" value=${mode} onChange=${setUp('mode')} options=${[['auto', 'The build in progress'], ['manual', 'Something I write'], ['off', 'Nothing (hidden)']]} />
      ${mode === 'auto' && html`
        <p class="sc-note">${nowBuilding
          ? html`Showing <strong>${nowBuilding.name}’s ${roomsText(nowBuilding)}</strong>, “Now Building”${(up.dateText || autoDate) ? html`, “${up.dateText || autoDate}”` : ''}, with a Meet ${nowBuilding.name} button.`
          : 'No build is in progress, so it shows the next event, or hides when there isn’t one.'}</p>
        <div class="sc-pair">
          <${KidPicker} label="Which build" value=${up.kidSlug || ''} kids=${c.kids} filter=${(k) => k.status === 'in-progress'} blankLabel="The next reveal in JobTread" onChange=${setUp('kidSlug')} hint="Only kids being built now are listed." />
          <${TextField} label="Date line" value=${up.dateText} onChange=${setUp('dateText')} placeholder=${autoDate || 'Reveal coming soon'} max=${40} optional hint="Fills in from JobTread: “Reveal mid November” while the date is tentative, the day once it’s confirmed. Type here only to say something else." />
        </div>`}
      ${mode === 'manual' && html`
        <div class="sc-split">
          <div class="sc-stack">
            <div class="sc-pair">
              <${TextField} label="Label" value=${up.label} onChange=${setUp('label')} placeholder="Up Next" max=${24} />
              <${TextField} label="Date line" value=${up.date} onChange=${setUp('date')} placeholder="Saturday, May 2" max=${40} optional />
            </div>
            <${TextField} label="Headline" value=${up.headline} onChange=${setUp('headline')} max=${70} problem=${!String(up.headline || '').trim() ? 'Without a headline the strip stays hidden' : null} />
            <${AreaField} label="One or two sentences" value=${up.body} onChange=${setUp('body')} max=${200} rows=${2} optional />
            <div class="sc-pair">
              <${TextField} label="Button" value=${up.ctaLabel} onChange=${setUp('ctaLabel')} placeholder="Learn More" max=${24} />
              <${TextField} label="Goes to" value=${up.ctaLink} onChange=${setUp('ctaLink')} placeholder="/events/" problem=${S.linkProblem(up.ctaLink)} hint="A link to another site opens in a new tab." />
            </div>
          </div>
          <${PhotoField} ...${photoProps(c, 'upNext.photo', { optional: true })} />
        </div>`}
      ${mode === 'off' && html`<p class="sc-note">The strip is hidden. Pick another option to bring it back.</p>`}
    <//>

    <${Card} id="sc-mission" title="Our Mission photos" sub="Two overlapping photos beside the mission statement.">
      <${Photos} cols="2">
        <${PhotoField} ...${photoProps(c, 'sectionPhotos.missionMain', { fallback: 'kids/eli/photo-01' })} />
        <${PhotoField} ...${photoProps(c, 'sectionPhotos.missionAccent', { fallback: 'kids/georgia/photo-01' })} />
      <//>
    <//>

    <${Card} id="sc-rooms" title="The rooms we build" sub="Three cards, in this order on the page.">
      <${Photos} cols="3">
        <${PhotoField} ...${photoProps(c, 'sectionPhotos.roomBath')} />
        <${PhotoField} ...${photoProps(c, 'sectionPhotos.roomBedroom')} />
        <${PhotoField} ...${photoProps(c, 'sectionPhotos.roomTherapy')} />
      <//>
    <//>

    <${Card} id="sc-featured" title="Featured Story" sub="One family’s story, further down the homepage.">
      <div class="sc-split">
        <div class="sc-stack">
          <${KidPicker} label="Family" value=${st.featuredKidSlug || ''} kids=${c.kids} blankLabel="Zyah (built in)"
            hint="Also the “Meet …” family on the Apply page."
            onChange=${(slug) => c.update('settings', (e) => S.withPhoto(S.setPath(e, 'featuredKidSlug', slug), 'featuredStoryImage', ''))} />
          <${TextField} label="Headline" value=${st.featuredStoryHeadline} onChange=${(v) => c.set('settings', 'featuredStoryHeadline', v)} placeholder=${autoHeadline} max=${110} hint="Blank uses the sentence shown." />
          <${AreaField} label="Paragraph" value=${st.featuredStoryDescription} onChange=${(v) => c.set('settings', 'featuredStoryDescription', v)} placeholder=${autoText} max=${400} rows=${4} hint="Blank uses the paragraph shown, built from their profile." />
        </div>
        <${PhotoField} ...${photoProps(c, 'featuredStoryImage', { kidSlug: featuredSlug, fallback: heroIdOf(c.kids, featuredSlug) })} />
      </div>
    <//>

    <${Card} id="sc-strip" title="Kid strip" sub="The row of kids near the bottom. Names, ages and rooms come from each kid’s profile.">
      <${ListEditor} items=${strip} keyOf=${(it, i) => `${it.slug || 'x'}-${i}`} label="kid" addToast=${c.addToast}
        onChange=${(v) => c.update('settings', (e) => ({ ...S.setPath(e, 'kidShowcase', v), photoTimestamps: { ...(e.photoTimestamps || {}), kidShowcase: new Date().toISOString() } }))}
        empty="No kids in the strip, so it’s empty on the page."
        onAdd=${() => setAdding(true)} addLabel="Add a kid"
        renderItem=${(it) => { const k = c.kids.find(x => x.slug === it.slug); return html`
          <div class="sc-kidrow">
            <img class="sc-avatar is-lg" src=${kidThumb(k || { slug: it.slug }, 96)} alt="" loading="lazy" />
            <div><strong>${k ? S.kidLabel(k) : it.slug}</strong><span class="sc-hint">${k ? [kidAgeText(k), (k.roomTypes || [])[0], STATUS_TEXT[k.status]].filter(Boolean).join(' · ') : 'Not a kid on the site any more'}</span></div>
            ${(!k || k.publishStatus === 'draft') && html`<span class="sc-chip is-warn">${k ? 'Draft: not shown' : 'Missing'}</span>`}
          </div>`; }} />
      ${adding && html`
        <div class="sc-adding">
          <${KidPicker} label="Add a kid" value="" kids=${c.kids} filter=${(k) => !strip.some(s => s.slug === k.slug)}
            onChange=${(slug) => { setAdding(false); if (slug) c.update('settings', (e) => ({ ...S.setPath(e, 'kidShowcase', [...strip, { slug, cfId: heroIdOf(c.kids, slug) }]), photoTimestamps: { ...(e.photoTimestamps || {}), kidShowcase: new Date().toISOString() } })); }} />
          <button type="button" class="btn btn-ghost btn-sm" onClick=${() => setAdding(false)}>Cancel</button>
        </div>`}
    <//>

    <${Card} title="Also on the homepage" sub="These come from other parts of the admin.">
      <ul class="sc-links">
        <li><span><strong>${snap?.programPct || 0}% Program Services</strong>, from the Financials numbers (${snap?.year ? `FY ${snap.year}` : 'no year set'}).</span><button type="button" class="btn btn-ghost btn-sm" onClick=${() => c.go('financials', 'sc-numbers')}>Edit the numbers</button></li>
        <li><span><strong>Partner logos</strong> scroll by for every Signature partner with a logo, in the order set in Partners.</span><button type="button" class="btn btn-ghost btn-sm" onClick=${() => c.open('partners-hub')}>Open Partners</button></li>
        <li><span><strong>Kid cards and stories</strong> come from each kid’s profile.</span><button type="button" class="btn btn-ghost btn-sm" onClick=${() => c.open('kids-hub')}>Open Kids</button></li>
      </ul>
    <//>`;
}
const kidAgeText = (k) => (Array.isArray(k?.age) ? `ages ${k.age.join(', ')}` : `age ${k?.age || 7}`);

/** The hero's words as the homepage sets them: small line, two-line headline with the marker, paragraph, buttons */
function HeroPreview({ hero }) {
  const l1 = hero.headlineLine1 || 'Building <em>dreams</em>,';
  const l2 = hero.headlineLine2 || 'one room at a time';
  return html`
    <figure class="sc-hero-pv" aria-label="Preview of the hero words">
      <figcaption class="sc-pv-tag">Preview</figcaption>
      <p class="sc-hero-pv-eyebrow">${hero.eyebrow || '501(c)(3) Nonprofit · Atlanta, GA · Since 2012'}</p>
      <p class="sc-hero-pv-h" dangerouslySetInnerHTML=${{ __html: `${cleanInline(l1)}<br>${cleanInline(l2)}` }}></p>
      <p class="sc-hero-pv-lead" dangerouslySetInnerHTML=${{ __html: cleanInline(hero.lead || 'Dream bedrooms, accessible bathrooms, and therapy rooms for children with special needs, at no cost to families.') }}></p>
      <div class="sc-hero-pv-btns"><span class="is-yellow">${hero.cta1Label || 'Give Today'}</span><span class="is-dark">${S.withoutArrow(hero.cta2Label || 'See Our Work')} ↓</span></div>
    </figure>`;
}

function KidsPage({ c }) {
  const st = c.doc('settings');
  return html`
    <${Card} title="Under the page title" sub="The line beneath “Meet the Kids”.">
      <${AreaField} label="Line" value=${st.kidsPageSummary} onChange=${(v) => c.set('settings', 'kidsPageSummary', v)} placeholder="Every room we build changes a child's world." max=${200} rows=${2} />
    <//>
    <${Card} title="Also on this page" sub="The kids, their order and their photos come from Kids.">
      <ul class="sc-links"><li><span>Order, status and photos for each kid.</span><button type="button" class="btn btn-ghost btn-sm" onClick=${() => c.open('kids-hub')}>Open Kids</button></li></ul>
    <//>`;
}

function HowPage({ c }) {
  const st = c.doc('settings');
  const ready = (k) => (k.plans?.length || 0) > 0 && !!(k.streamVideoId || k.videoUrl);
  const pub = S.publishedKids(c.kids);
  const pinned = st.howItWorks?.kidSlug || 'amari';
  const shown = pub.find(k => k.slug === pinned && ready(k)) || pub.filter(ready).sort((a, b) => (b.year || 0) - (a.year || 0))[0] || pub.find(k => k.slug === pinned) || pub[0];
  const picked = c.kids.find(k => k.slug === pinned);
  return html`
    <${Card} title="The project followed start to finish" sub="How It Works walks through one real makeover: the drawings, the build and the reveal.">
      <${KidPicker} label="Project" value=${st.howItWorks?.kidSlug || ''} kids=${c.kids} blankLabel="Amari (built in)"
        describe=${(k) => (ready(k) ? 'Drawings and reveal video' : 'Missing drawings or a reveal video')}
        onChange=${(v) => c.set('settings', 'howItWorks.kidSlug', v)} />
      <p class="sc-note">${shown ? html`The page shows <strong>${shown.name}</strong>.` : null}
        ${picked && !ready(picked) ? html` ${picked.name} has no ${picked.plans?.length ? 'reveal video' : 'design drawings'} yet, so the page uses the newest project that has both.` : ''}
        Drawings go in a kid’s Plans; the video is their reveal video.</p>
    <//>`;
}

function ApplyPage({ c }) {
  const st = c.doc('settings');
  const app = st.application || {};
  const featured = c.kids.find(k => k.slug === (st.featuredKidSlug || 'amari'));
  const t = st.applyTestimonial || {};
  const faqs = Array.isArray(st.applyFaqs) ? st.applyFaqs : [];
  return html`
    <${Card} title="Open or closed" sub="Applications open and close in Applications, along with the season and the closed message.">
      <div class="sc-callout ${app.open ? 'is-open' : ''}">
        <span class="sc-dot" aria-hidden="true"></span>
        <span><strong>${app.open ? 'Applications are open' : 'Applications are closed'}</strong>${app.year ? ` for the ${app.year} season` : ''}.</span>
        <button type="button" class="btn btn-ghost btn-sm" onClick=${() => c.open('applications', '#applications/settings')}>Open Applications → Settings</button>
      </div>
    <//>
    <${Card} title="Photos" sub="The hero, then one photo for each step of “The Journey” so nothing repeats.">
      <${Photos} cols="2">
        <${PhotoField} ...${photoProps(c, 'applyPhotos.hero')} />
        <${PhotoField} ...${photoProps(c, 'applyPhotos.story')} />
      <//>
      <h4 class="sc-h4">The Journey</h4>
      <${Photos} cols="3">
        <${PhotoField} ...${photoProps(c, 'applyPhotos.selection')} />
        <${PhotoField} ...${photoProps(c, 'applyPhotos.build', { borrows: true, fallback: st.applyPhotos?.story || 'kids/eli/photo-01' })} />
        <${PhotoField} ...${photoProps(c, 'sectionPhotos.process')} />
      <//>
    <//>
    <${Card} title="Meet the family" sub="A short profile of one family who applied.">
      <div class="sc-callout">
        ${featured && html`<img class="sc-avatar is-lg" src=${kidThumb(featured, 96)} alt="" />`}
        <span>Shows <strong>${featured?.name || 'Amari'}</strong>, the homepage Featured Story family.</span>
        <button type="button" class="btn btn-ghost btn-sm" onClick=${() => c.go('home', 'sc-featured')}>Change on the Homepage</button>
      </div>
    <//>
    <${Card} title="Family quote" sub="A few words from a family, in large type.">
      <${AreaField} label="Quote" value=${t.quote} onChange=${(v) => c.set('settings', 'applyTestimonial.quote', v)} rows=${3} max=${400}
        placeholder="When we walked through the door, our son just froze…" hint="Blank shows a quote from a completed makeover instead." />
      <${TextField} label="Who said it" value=${t.attribution} onChange=${(v) => c.set('settings', 'applyTestimonial.attribution', v)} placeholder="The Johnson Family" max=${60} />
    <//>
    <${Card} title="Questions" sub="Shown numbered on the Apply page, and to Google as FAQ answers. Remove them all to hide the section.">
      <${ListEditor} items=${faqs} label="question" addToast=${c.addToast} onChange=${(v) => c.set('settings', 'applyFaqs', v)}
        make=${() => ({ question: '', answer: '' })} addLabel="Add a question" empty="No questions, so the section is hidden."
        renderItem=${(q, i, up) => html`
          <div class="sc-stack">
            <${TextField} label=${`Question ${i + 1}`} value=${q.question} onChange=${(v) => up({ question: v })} problem=${!String(q.question || '').trim() ? 'Write the question, or remove it' : null} />
            <${InlineRich} label="Answer" value=${q.answer} onChange=${(v) => up({ answer: v })} marks=${['strong', 'link']} problem=${!S.plainText(q.answer) ? 'Write the answer, or remove the question' : null} />
          </div>`} />
    <//>`;
}

function DonatePage({ c }) {
  const st = c.doc('settings');
  const dp = st.donatePhotos || {};
  const storySlug = dp.storyKidSlug || (dp.storyKidName || 'Amari').toLowerCase().replace(/\s+/g, '-');
  const storyKid = c.kids.find(k => k.slug === storySlug);
  const photoKid = S.kidSlugOfImage(S.cfIdOf(dp.story));
  const mismatch = storyKid && photoKid && photoKid !== storyKid.slug ? c.kids.find(k => k.slug === photoKid) : null;
  const faq = c.doc('faq');
  const starred = (faq?.categories || []).filter(x => x.showOnDonatePage);
  const names = S.publishedKids(c.kids).map(k => k.name);
  return html`
    <${Card} title="Hero" sub="The large photo at the top of the Donate page.">
      <div class="sc-split">
        <${PhotoField} ...${photoProps(c, 'donatePhotos.hero')} />
        <div class="sc-stack">
          <${TextField} label="Who’s in the photo" value=${dp.heroKidName} onChange=${(v) => c.set('settings', 'donatePhotos.heroKidName', v)} placeholder="Oakley" max=${60} list="sc-kid-names" hint="Read aloud by screen readers." />
          <datalist id="sc-kid-names">${names.map(n => html`<option value=${n} />`)}</datalist>
        </div>
      </div>
    <//>
    <${Card} title="Family story" sub="A photo and a few lines from one family’s profile, with a link to their page.">
      <div class="sc-split">
        <div class="sc-stack">
          <${KidPicker} label="Family" value=${storyKid ? storyKid.slug : ''} kids=${c.kids} blankLabel="Amari (built in)"
            problem=${!storyKid && (dp.storyKidSlug || dp.storyKidName) ? `“${dp.storyKidName || dp.storyKidSlug}” doesn’t match a kid, so the story has no profile or link. Pick the family.` : null}
            hint="Their bio, rooms and page link come from their profile."
            onChange=${(slug) => { const k = c.kids.find(x => x.slug === slug); c.update('settings', (e) => S.setPath(S.setPath(e, 'donatePhotos.storyKidSlug', slug || undefined), 'donatePhotos.storyKidName', k?.name || undefined)); }} />
          ${mismatch && html`<p class="sc-note is-warn"><${Icon} name="warn" /> The photo is from ${mismatch.name}’s photos, but the story is ${storyKid.name}’s.</p>`}
        </div>
        <${PhotoField} ...${photoProps(c, 'donatePhotos.story', { kidSlug: storyKid?.slug || null })} />
      </div>
    <//>
    <${Card} title="Questions on this page" sub="Every question in a starred FAQ category.">
      <ul class="sc-links">
        ${starred.map(cat => html`<li><span><${Icon} name="star" size=${14} /> <strong>${cat.label}</strong>, ${S.faqItems(faq, cat.id).length} questions</span></li>`)}
        ${!starred.length && html`<li><span>No category is starred, so the Donate page has no questions.</span></li>`}
        <li><span>Star a category in FAQ to show it here.</span><button type="button" class="btn btn-ghost btn-sm" onClick=${() => c.go('faq')}>Open FAQ</button></li>
      </ul>
    <//>`;
}

function WaysPage({ c }) {
  return html`
    <${Card} title="Photos" sub="Top to bottom, as they appear on Ways to Give.">
      <${Photos} cols="3">
        <${PhotoField} ...${photoProps(c, 'waysToGivePhotos.hero')} />
        <${PhotoField} ...${photoProps(c, 'waysToGivePhotos.breakPhoto')} />
        <${PhotoField} ...${photoProps(c, 'waysToGivePhotos.legacyPhoto')} />
      <//>
    <//>`;
}

function PartnersPage({ c }) {
  const st = c.doc('settings');
  const set = (k) => (v) => c.set('settings', k, v);
  return html`
    <${Card} title="Hero" sub="The photo at the top of the Partners page.">
      <${Photos} cols="2"><${PhotoField} ...${photoProps(c, 'partnerPhoto')} /><//>
    <//>
    <${Card} title="Partner quote" sub="A few words from a build partner, in large type.">
      <${AreaField} label="Quote" value=${st.partnerQuote} onChange=${set('partnerQuote')} rows=${2} max=${260} placeholder="Seeing the look on a child’s face when they walk into their new room. That’s why we show up every build day." />
      <div class="sc-pair">
        <${TextField} label="Name" value=${st.partnerQuoteName} onChange=${set('partnerQuoteName')} placeholder="Lee Hainer" max=${60} />
        <${TextField} label="Company" value=${st.partnerQuoteOrg} onChange=${set('partnerQuoteOrg')} placeholder="Lee Hainer Construction" max=${80} />
      </div>
      <p class="sc-hint">Blank fields show Lee Hainer’s quote.</p>
    <//>
    <${Card} title="Also on this page" sub="Partners, their levels and logos come from Partners.">
      <ul class="sc-links"><li><span>Every partner card, logo and level.</span><button type="button" class="btn btn-ghost btn-sm" onClick=${() => c.open('partners-hub')}>Open Partners</button></li></ul>
    <//>`;
}

function CommunityPage({ c }) {
  return html`
    <${Card} title="Hero photos" sub="A large photo and a smaller one overlapping it.">
      <${Photos} cols="2">
        <${PhotoField} ...${photoProps(c, 'communityPhotos.hero', { uploadPrefix: 'community' })} />
        <${PhotoField} ...${photoProps(c, 'communityPhotos.accent', { uploadPrefix: 'community', fallback: 'community/summit-counseling-center/hero' })} />
      <//>
    <//>`;
}

function ResourcesPage({ c }) {
  return html`
    <${Card} title="Photos" sub="Every guide without its own photo uses the hero photo. A guide’s own photo is set in Articles.">
      <${Photos} cols="2">
        <${PhotoField} ...${photoProps(c, 'resourcesPhotos.hero')} />
        <${PhotoField} ...${photoProps(c, 'resourcesPhotos.why', { borrows: true, fallback: c.doc('settings').sectionPhotos?.missionMain || 'kids/eli/photo-01' })} />
      <//>
    <//>`;
}

function AdvisoryPage({ c }) {
  return html`
    <${Card} title="Hero" sub="The photo at the top of the Advisory Board page. Members come from People.">
      <${Photos} cols="2"><${PhotoField} ...${photoProps(c, 'advisoryBoardPhotos.hero')} /><//>
    <//>`;
}

// ─── Our Story ─────────────────────────────────────────────────────
const MILESTONE_SPEC = { ratio: 480 / 280, crop: 'face', label: 'Photo', where: 'Shows when the milestone is open; a small square of it marks the year' };

function AboutPage({ c }) {
  const o = c.doc('our-story');
  const set = (p) => (v) => c.set('our-story', p, v);
  const photo = (key) => html`<${PhotoField} path=${`images.${key}`} value=${o.images?.[key] || ''} onChange=${set(`images.${key}`)} kids=${c.kids} uploadPrefix="our-story" />`;
  const chapter = (key, title, sub, img, extra = null) => html`
    <${Card} id=${`sc-${key}`} title=${title} sub=${sub}>
      <div class="sc-split is-photo-first">
        ${img ? photo(img) : null}
        <div class="sc-stack">
          <${TextField} label="Small label" value=${o[key]?.label} onChange=${set(`${key}.label`)} max=${40} />
          <${InlineRich} label="Heading" value=${o[key]?.heading} onChange=${set(`${key}.heading`)} emClass="highlight" display />
          <${Paragraphs} label="Paragraphs" value=${o[key]?.paragraphs || []} onChange=${set(`${key}.paragraphs`)} />
          ${extra}
        </div>
      </div>
    <//>`;
  const today = String(o.today?.body || '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
  const miles = Array.isArray(o.milestones) ? o.milestones : [];
  return html`
    ${chapter('founders', 'How it began', 'Peter and Holly’s story, under the founders photo.', 'founder')}
    ${chapter('turningPoint', 'The turning point', 'Tripp’s story.', 'tripp')}
    ${chapter('mascot', 'Gracie', 'The mascot section.', 'gracie', html`<${InlineRich} label="Closing line" value=${o.mascot?.tagline} onChange=${set('mascot.tagline')} marks=${['strong', 'em']} emClass="highlight" />`)}
    ${chapter('store', 'Sunny & Ranney', 'The store that funds the rooms. The Shop button is built in.', 'store')}
    <${Card} id="sc-timeline" title="Timeline" sub="Oldest first. The first milestone starts open; the rest alternate sides.">
      <${ListEditor} items=${miles} label="milestone" addToast=${c.addToast} onChange=${set('milestones')}
        make=${() => ({ year: String(new Date().getFullYear()), title: '', desc: '' })} addLabel="Add a milestone"
        renderItem=${(m, i, up) => html`
          <div class="sc-mile">
            <${PhotoField} compact path=${`milestones.${i}.image`} spec=${MILESTONE_SPEC} value=${m.image || ''} onChange=${(v) => up({ image: v || undefined })} kids=${c.kids} uploadPrefix="our-story" optional />
            <div class="sc-stack">
              <div class="sc-pair is-narrow-first">
                <${TextField} label="Year" value=${m.year} onChange=${(v) => up({ year: v })} max=${4} inputmode="numeric" problem=${!/^\d{4}$/.test(String(m.year || '')) ? 'A four-digit year' : null} />
                <${TextField} label="Title" value=${m.title} onChange=${(v) => up({ title: v })} max=${60} problem=${!String(m.title || '').trim() ? 'Give it a title' : null} />
              </div>
              <${AreaField} label="What happened" value=${m.desc} onChange=${(v) => up({ desc: v })} rows=${2} max=${320} />
              <${AreaField} label="More detail" value=${m.detail} onChange=${(v) => up({ detail: v || undefined })} rows=${2} max=${600} optional hint="Under the description when the milestone is open." />
            </div>
          </div>`} />
    <//>
    <${Card} id="sc-today" title="Where we are today" sub="Near the end of the page.">
      <${TextField} label="Small label" value=${o.today?.label} onChange=${set('today.label')} max=${40} />
      <${InlineRich} label="Heading" value=${o.today?.heading} onChange=${set('today.heading')} emClass="highlight" display />
      <${Paragraphs} label="Paragraphs" value=${today} onChange=${(list) => set('today.body')(list.map(x => x.trim()).filter(Boolean).join('\n\n'))} />
    <//>
    <${Card} id="sc-finale" title="Closing" sub="The last words, above the buttons.">
      <${InlineRich} label="Heading" value=${o.finale?.heading} onChange=${set('finale.heading')} emClass="highlight" display />
      <${InlineRich} label="Paragraph" value=${o.finale?.body} onChange=${set('finale.body')} marks=${['em', 'strong', 'link']} emClass="highlight" />
    <//>`;
}

// ─── Financials ────────────────────────────────────────────────────
function NumberInput({ label, value, onChange, money = false, hint = null, problem = null }) {
  const id = useId();
  const [txt, setTxt] = useState(null);
  const n = Number(value) || 0;
  const shown = txt ?? (n ? n.toLocaleString('en-US') : '');
  return html`
    <${Field} label=${label} id=${id} hint=${hint} problem=${problem}>
      <div class="sc-num ${money ? 'is-money' : ''}">
        ${money && html`<span aria-hidden="true">$</span>`}
        <input id=${id} class="form-input" inputmode="numeric" value=${shown} placeholder="0"
          onInput=${(e) => { setTxt(e.target.value); const v = Number(String(e.target.value).replace(/[^\d.]/g, '')); onChange(Number.isFinite(v) ? Math.round(v) : 0); }}
          onBlur=${() => setTxt(null)} />
      </div>
    <//>`;
}

function FinancialsPage({ c }) {
  const snap = c.doc('financial-snapshot');
  const setSnap = (k) => (v) => c.update('financial-snapshot', (e) => S.withPercents({ ...e, [k]: v }));
  const total = (Number(snap.programExpenses) || 0) + (Number(snap.managementExpenses) || 0) + (Number(snap.fundraisingExpenses) || 0);
  const sum = (snap.programPct || 0) + (snap.managementPct || 0) + (snap.fundraisingPct || 0);
  const years = (() => { const y = new Date().getFullYear(); return [y, y - 1, y - 2, y - 3, y - 4]; })();
  return html`
    <${Card} id="sc-fhero" title="Hero" sub="The photo at the top of the Financials page.">
      <${Photos} cols="2"><${PhotoField} ...${photoProps(c, 'financialsPhotos.hero')} /><//>
    <//>
    <${Card} id="sc-numbers" title="The numbers" sub="From the latest Form 990 or audit. The homepage shows the program share; the Financials page shows them all.">
      <div class="sc-pair">
        <div class="sc-field">
          <label class="sc-label" for="sc-fy">Fiscal year</label>
          <select id="sc-fy" class="form-input" value=${String(snap.year || '')} onChange=${(e) => c.set('financial-snapshot', 'year', Number(e.target.value))}>
            ${[...new Set([Number(snap.year) || years[1], ...years])].sort((a, b) => b - a).map(y => html`<option value=${String(y)}>FY ${y}</option>`)}
          </select>
          <div class="sc-under"><span class="sc-hint">The year the 990 covers.</span></div>
        </div>
      </div>
      <h4 class="sc-h4">Where the money went</h4>
      <div class="sc-trio">
        <${NumberInput} label="Programs" money value=${snap.programExpenses} onChange=${setSnap('programExpenses')} />
        <${NumberInput} label="Management and general" money value=${snap.managementExpenses} onChange=${setSnap('managementExpenses')} />
        <${NumberInput} label="Fundraising" money value=${snap.fundraisingExpenses} onChange=${setSnap('fundraisingExpenses')} />
      </div>
      <div class="sc-split-bar" role="img" aria-label=${`Of every dollar: ${snap.programPct || 0} cents to programs, ${snap.managementPct || 0} to management, ${snap.fundraisingPct || 0} to fundraising`}>
        <span class="is-prog" style=${`flex:${snap.programPct || 0}`}></span><span class="is-mgmt" style=${`flex:${snap.managementPct || 0}`}></span><span class="is-fund" style=${`flex:${snap.fundraisingPct || 0}`}></span>
      </div>
      <p class="sc-split-key"><span><i class="is-prog"></i>Programs ${snap.programPct || 0}¢</span><span><i class="is-mgmt"></i>Management ${snap.managementPct || 0}¢</span><span><i class="is-fund"></i>Fundraising ${snap.fundraisingPct || 0}¢</span><span class="sc-muted">Total spent $${total.toLocaleString('en-US')}</span></p>
      ${total > 0 && sum !== 100 && html`<p class="sc-hint">Rounded, these add to ${sum}¢; the page gives the difference to fundraising.</p>`}
      <h4 class="sc-h4">Money in, and what’s left</h4>
      <div class="sc-pair">
        <${NumberInput} label="Total revenue" money value=${snap.totalRevenue} onChange=${setSnap('totalRevenue')} />
        <${NumberInput} label="Store revenue (net)" money value=${snap.storeRevenue} onChange=${setSnap('storeRevenue')} />
        <${NumberInput} label="Net assets, end of year" money value=${snap.netAssets} onChange=${setSnap('netAssets')} />
        <${NumberInput} label="Contributions and grants" money value=${snap.contributions} onChange=${setSnap('contributions')} hint="Kept for your records; not shown on the site." />
      </div>
      <h4 class="sc-h4">People</h4>
      <div class="sc-pair">
        <${NumberInput} label="Employees" value=${snap.employees} onChange=${setSnap('employees')} />
        <${NumberInput} label="Volunteers" value=${snap.volunteers} onChange=${setSnap('volunteers')} hint="Shown with a +." />
      </div>
      <div class="sc-pv-line">
        <span><span class="sc-pv-tag">Homepage</span> <strong>${snap.programPct || 0}% Program Services</strong></span>
        <span><span class="sc-pv-tag">Financials page</span> FY ${snap.year} · ${S.moneyShort(snap.totalRevenue)} revenue · ${S.moneyShort(snap.programExpenses)} to programs · ${S.moneyShort(snap.storeRevenue)} from the store · ${S.moneyShort(snap.netAssets)} net assets · ${snap.employees || 0} staff · ${snap.volunteers || 0}+ volunteers</span>
      </div>
    <//>
    <${FinancialDocs} c=${c} />
    <${AnnualReports} c=${c} />`;
}

const FILES_ORIGIN = 'https://files.sunshineonaranneyday.com/financials/';
let uploadedNames = null;
async function financialNames(force = false) {
  if (uploadedNames && !force) return uploadedNames;
  const j = await call('/api/list-content?dir=public/financials');
  uploadedNames = new Set((j.items || []).map(i => i.name));
  return uploadedNames;
}
/** Into R2 under financials/. A name already there gets a suffix: those files are cached for a year */
async function uploadFinancialFile(file) {
  if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} is over 50 MB`);
  const names = await financialNames();
  let name = file.name.replace(/[^a-z0-9._-]/gi, '-');
  if (names.has(name)) { const dot = name.lastIndexOf('.'); name = dot > 0 ? `${name.slice(0, dot)}-${Date.now().toString(36)}${name.slice(dot)}` : `${name}-${Date.now().toString(36)}`; }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('path', `public/financials/${name}`);
  fd.append('message', `Upload financial document: ${file.name}`);
  const j = await call('/api/upload-file', fd);
  if (!j.success) throw new Error(j.error || 'Upload failed');
  names.add(name);
  return { name, url: `${FILES_ORIGIN}${name}` };
}
const DOC_TYPES = [['990', 'Tax returns (Form 990)', (y) => `${y} 990 Tax Return`], ['audit', 'Audited financial statements', (y) => `${y} Financial Audit`], ['other', 'Also on file', () => '']];
const fileNameOf = (url) => decodeURIComponent(String(url || '').split('/').pop() || '');

function FileButton({ label = 'Upload a file', accept = '.pdf,application/pdf', onFile, busy = false, ghost = true }) {
  const ref = useRef(null);
  return html`
    <button type="button" class=${`btn ${ghost ? 'btn-ghost' : 'btn-primary'} btn-sm`} disabled=${busy} onClick=${() => ref.current?.click()}><${Icon} name="upload" size=${14} /> ${busy ? 'Uploading…' : label}</button>
    <input ref=${ref} type="file" accept=${accept} hidden onChange=${(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />`;
}

function FinancialDocs({ c }) {
  const docs = c.doc('financials').documents || [];
  const [adding, setAdding] = useState(null);
  const [busy, setBusy] = useState(null);
  const setDocs = (fn) => c.update('financials', (e) => ({ ...e, documents: fn(e.documents || []) }));
  const upd = (idx, patch) => setDocs(list => list.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  const remove = (idx) => {
    const gone = docs[idx];
    setDocs(list => list.filter((_, i) => i !== idx));
    c.addToast(`Removed ${gone.title || gone.year}.`, 'info', { label: 'Undo', fn: () => setDocs(list => [...list.slice(0, idx), gone, ...list.slice(idx)]) });
  };
  const replace = async (idx, file) => {
    setBusy(idx);
    try { const up = await uploadFinancialFile(file); upd(idx, { url: up.url, fileName: up.name, source: 'local' }); c.addToast(`Uploaded ${file.name}.`, 'success'); }
    catch (e) { c.addToast(`Couldn't upload: ${e.message}`, 'error'); }
    setBusy(null);
  };
  return html`
    <${Card} id="sc-docs" title="990s, audits and other documents" sub="Each year links to its file. The newest 990 and audit get the designed covers.">
      ${DOC_TYPES.map(([type, title]) => {
        const rows = docs.map((d, i) => ({ d, i })).filter(x => (x.d.type || 'other') === type).sort((a, b) => (b.d.year || 0) - (a.d.year || 0));
        return html`
          <div class="sc-docs" key=${type}>
            <div class="sc-docs-head"><h4 class="sc-h4">${title} <span class="sc-count">${rows.length}</span></h4>
              <button type="button" class="btn btn-ghost btn-sm" onClick=${() => setAdding(type)}><${Icon} name="plus" size=${14} /> Add</button></div>
            <ul class="sc-doclist">
              ${rows.map(({ d, i }) => html`
                <li key=${`${type}-${i}`}>
                  <input class="form-input sc-year" inputmode="numeric" aria-label="Year" value=${d.year ?? ''} aria-invalid=${!/^\d{4}$/.test(String(d.year || '')) ? 'true' : 'false'}
                    onInput=${(e) => upd(i, { year: Number(e.target.value.replace(/\D/g, '').slice(0, 4)) || '' })} />
                  ${type === 'other'
                    ? html`<input class="form-input" aria-label="Title" value=${d.title || ''} placeholder="Title" onInput=${(e) => upd(i, { title: e.target.value })} />`
                    : html`<span class="sc-doc-name" title=${d.url}><${Icon} name="file" size=${14} /> ${fileNameOf(d.url) || 'No file'}</span>`}
                  <span class="sc-row-actions">
                    ${d.url && html`<a class="btn btn-ghost btn-sm" href=${d.url} target="_blank" rel="noopener">View <${Icon} name="ext" size=${12} /></a>`}
                    <${FileButton} label="Replace" busy=${busy === i} onFile=${(f) => replace(i, f)} />
                    <button type="button" class="sc-icon-btn sc-remove" aria-label=${`Remove ${d.title || d.year}`} onClick=${() => remove(i)}><${Icon} name="trash" size=${14} /></button>
                  </span>
                </li>`)}
              ${!rows.length && html`<li class="sc-empty">None yet.</li>`}
            </ul>
          </div>`;
      })}
      <p class="sc-hint">For 990s and audits the page shows only the year; titles show for “Also on file”. A title with “contractor” in it is also the Licensed Contractor link.</p>
      ${adding && html`<${AddDocDialog} type=${adding} onClose=${() => setAdding(null)} onAdd=${(doc) => { setDocs(list => [...list, doc]); setAdding(null); }} addToast=${c.addToast} />`}
    <//>`;
}

function AddDocDialog({ type: typeIn, onAdd, onClose, addToast, report = false }) {
  const [type, setType] = useState(typeIn || '990');
  const [year, setYear] = useState(String(new Date().getFullYear() - 1));
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [linkMode, setLinkMode] = useState(false);
  const auto = DOC_TYPES.find(t => t[0] === type)?.[2]?.(year) || '';
  const ready = /^\d{4}$/.test(year) && (file || (linkMode && !S.urlProblem(url) && url)) && (report || type !== 'other' || title.trim());
  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      let link = url.trim();
      let fileName;
      if (file && !linkMode) { const up = await uploadFinancialFile(file); link = up.url; fileName = up.name; }
      onAdd(report
        ? { title: `${year} Annual Report`, year: Number(year), url: link, coverImage: '', description: '' }
        : { title: title.trim() || auto, year: Number(year), type, url: link, source: fileName ? 'local' : 'external', ...(fileName ? { fileName } : {}) });
      addToast?.(`Added. Save to put it on the page.`, 'success');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return html`
    <${Dialog} title=${report ? 'Add an annual report' : 'Add a document'} onClose=${onClose}
      footer=${html`<button type="button" class="btn btn-ghost" onClick=${onClose}>Cancel</button><button type="button" class="btn btn-primary" disabled=${!ready || busy} onClick=${add}>${busy ? 'Uploading…' : 'Add'}</button>`}>
      <div class="sc-stack">
        ${!report && html`
          <div class="sc-field"><span class="sc-label">Kind</span>
            <${Segmented} label="Kind" value=${type} onChange=${setType} options=${[['990', 'Form 990'], ['audit', 'Audit'], ['other', 'Other']]} /></div>`}
        <div class="sc-pair">
          <${TextField} label="Year" value=${year} onChange=${(v) => setYear(v.replace(/\D/g, '').slice(0, 4))} inputmode="numeric" problem=${year && !/^\d{4}$/.test(year) ? 'A four-digit year' : null} />
          ${!report && type === 'other' && html`<${TextField} label="Title" value=${title} onChange=${setTitle} placeholder="Georgia contractor license" max=${80} />`}
        </div>
        ${!linkMode
          ? html`
            <div class="sc-drop is-small" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) setFile(f); }}>
              ${file ? html`<p><${Icon} name="file" /> <strong>${file.name}</strong> (${Math.round(file.size / 1024).toLocaleString()} KB)</p>` : html`<p>Drop the PDF here, or</p>`}
              <${FileButton} label=${file ? 'Choose another' : 'Choose a file'} accept=".pdf,application/pdf,image/*" onFile=${setFile} />
            </div>
            <button type="button" class="sc-link" onClick=${() => setLinkMode(true)}>Link to a file somewhere else instead</button>`
          : html`
            <${TextField} label="Link to the file" value=${url} onChange=${setUrl} placeholder="https://" problem=${url ? S.urlProblem(url) : null} inputmode="url" />
            <button type="button" class="sc-link" onClick=${() => setLinkMode(false)}>Upload a file instead</button>`}
        ${err && html`<p class="sc-bad">${err}</p>`}
      </div>
    <//>`;
}

const REPORT_SPEC = { ratio: 480 / 621, crop: 'center', label: 'Cover', where: 'The report’s card' };
function AnnualReports({ c }) {
  const reports = c.doc('financials').annualReports || [];
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);
  const setReports = (fn) => c.update('financials', (e) => ({ ...e, annualReports: fn(e.annualReports || []) }));
  const upd = (idx, patch) => setReports(list => list.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  const rows = reports.map((d, i) => ({ d, i })).sort((a, b) => (b.d.year || 0) - (a.d.year || 0));
  return html`
    <${Card} id="sc-reports" title="Annual reports" sub="The newest is featured at the top of the page; older ones become cards.">
      <ul class="sc-reports">
        ${rows.map(({ d, i }) => html`
          <li key=${`r-${i}`}>
            <${PhotoField} compact path=${`annualReports.${i}.coverImage`} spec=${REPORT_SPEC} value=${S.cfIdOf(d.coverImage)} onChange=${(v) => upd(i, { coverImage: v })} uploadPrefix="financials" optional />
            <div class="sc-stack">
              <${TextField} label="Year" value=${d.year ?? ''} onChange=${(v) => upd(i, { year: Number(v.replace(/\D/g, '').slice(0, 4)) || '' })} inputmode="numeric" problem=${!/^\d{4}$/.test(String(d.year || '')) ? 'A four-digit year' : null} />
              <span class="sc-doc-name"><${Icon} name="file" size=${14} /> ${fileNameOf(d.url) || 'No file'}</span>
              <span class="sc-row-actions">
                ${d.url && html`<a class="btn btn-ghost btn-sm" href=${d.url} target="_blank" rel="noopener">View <${Icon} name="ext" size=${12} /></a>`}
                <${FileButton} label="Replace" busy=${busy === i} onFile=${async (f) => { setBusy(i); try { const up = await uploadFinancialFile(f); upd(i, { url: up.url }); } catch (e) { c.addToast(`Couldn't upload: ${e.message}`, 'error'); } setBusy(null); }} />
                <button type="button" class="sc-icon-btn sc-remove" aria-label=${`Remove the ${d.year} report`} onClick=${() => { const gone = d; setReports(list => list.filter((_, j) => j !== i)); c.addToast(`Removed the ${d.year} report.`, 'info', { label: 'Undo', fn: () => setReports(list => [...list.slice(0, i), gone, ...list.slice(i)]) }); }}><${Icon} name="trash" size=${14} /></button>
              </span>
            </div>
          </li>`)}
      </ul>
      ${!rows.length && html`<p class="sc-empty">No reports yet.</p>`}
      <button type="button" class="btn btn-ghost btn-sm sc-add" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${14} /> Add a report</button>
      ${adding && html`<${AddDocDialog} report onClose=${() => setAdding(false)} onAdd=${(r) => { setReports(list => [...list, r]); setAdding(false); }} addToast=${c.addToast} />`}
    <//>`;
}

// ─── FAQ ───────────────────────────────────────────────────────────
function FaqPage({ c }) {
  const faq = c.doc('faq');
  const cats = faq.categories || [];
  const [openId, setOpenId] = useState(null);
  const setCats = (n) => c.update('faq', (f) => ({ ...f, categories: n }));
  /** One category's questions in a new order; they keep their slots in the stored list, new ones go last */
  const setItems = (catId, list) => c.update('faq', (f) => {
    const ids = new Set(list.map(x => x.id));
    const out = (f.items || []).filter(it => it.category !== catId || ids.has(it.id));
    const slots = out.map((it, i) => (it.category === catId ? i : -1)).filter(i => i >= 0);
    list.forEach((it, k) => { const row = { ...it, category: catId, order: k + 1 }; if (k < slots.length) out[slots[k]] = row; else out.push(row); });
    return { ...f, items: out };
  });
  const moveTo = (it, catId) => c.update('faq', (f) => {
    const top = Math.max(0, ...(f.items || []).filter(x => x.category === catId).map(x => x.order || 0));
    return { ...f, items: (f.items || []).map(x => (x.id === it.id ? { ...x, category: catId, order: top + 1 } : x)) };
  });
  return html`
    <${Card} id="sc-cats" title="Categories" sub="In order on the FAQ page. A starred category’s questions also show on the Donate page.">
      <${ListEditor} items=${cats} keyOf=${(cat) => cat.id} label="category" addToast=${c.addToast} onChange=${setCats}
        canRemove=${(cat) => (S.ABOUT_FAQ_CATEGORIES[cat.id] ? 'Our Story shows this category, so it stays' : S.faqItems(faq, cat.id).length ? 'Move or remove its questions first' : null)}
        make=${() => ({ id: `cat-${Date.now().toString(36)}`, label: '', showOnDonatePage: false })} addLabel="Add a category"
        renderItem=${(cat, i, up) => html`
          <div class="sc-catrow">
            <${TextField} label=${`Category ${i + 1}`} value=${cat.label} onChange=${(v) => up({ label: v })} max=${40} problem=${!String(cat.label || '').trim() ? 'Name it' : null} />
            <label class="sc-check"><input type="checkbox" checked=${!!cat.showOnDonatePage} onChange=${(e) => up({ showOnDonatePage: e.target.checked })} /><${Icon} name="star" size=${14} /> On the Donate page</label>
            <span class="sc-hint">${S.faqItems(faq, cat.id).length} questions${S.ABOUT_FAQ_CATEGORIES[cat.id] ? ' · also on Our Story' : ''}</span>
          </div>`} />
    <//>
    ${cats.map(cat => html`
      <${Card} key=${cat.id} id=${`sc-cat-${cat.id}`} title=${cat.label || 'Untitled category'} sub=${[cat.showOnDonatePage ? 'Also on the Donate page' : null, S.ABOUT_FAQ_CATEGORIES[cat.id] ? 'Also on Our Story' : null].filter(Boolean).join(' · ') || 'On the FAQ page'}>
        <${ListEditor} items=${S.faqItems(faq, cat.id)} keyOf=${(it) => it.id} label="question" addToast=${c.addToast} onChange=${(list) => setItems(cat.id, list)}
          onAdd=${() => { const id = `faq-${Date.now().toString(36)}`; setItems(cat.id, [...S.faqItems(faq, cat.id), { id, question: '', answer: '', category: cat.id }]); setOpenId(id); }} addLabel="Add a question"
          renderItem=${(it, i, up) => html`<${FaqItem} it=${it} n=${i + 1} up=${up} open=${openId === it.id} onToggle=${() => setOpenId(openId === it.id ? null : it.id)} cats=${cats} onMove=${(id) => moveTo(it, id)} />`} />
      <//>`)}`;
}

function FaqItem({ it, n, up, open, onToggle, cats, onMove }) {
  const bad = !String(it.question || '').trim() || !S.plainText(it.answer);
  if (!open) return html`
    <button type="button" class="sc-faq ${bad ? 'is-bad' : ''}" aria-expanded="false" onClick=${onToggle}>
      <span class="sc-faq-n">${String(n).padStart(2, '0')}</span>
      <span class="sc-faq-text"><strong>${it.question || 'New question'}</strong><span class="sc-hint">${S.plainText(it.answer).slice(0, 140) || 'No answer yet'}</span></span>
      ${bad && html`<span class="sc-chip is-warn">Needs an answer</span>`}
    </button>`;
  return html`
    <div class="sc-faq-edit">
      <${TextField} label=${`Question ${n}`} value=${it.question} onChange=${(v) => up({ question: v })} max=${160} problem=${!String(it.question || '').trim() ? 'Write the question' : null} />
      <${InlineRich} label="Answer" value=${it.answer} onChange=${(v) => up({ answer: v })} marks=${['strong', 'link']} problem=${!S.plainText(it.answer) ? 'Write the answer' : null} hint=${`${MOD}K links a few words, e.g. to /partners/.`} />
      <div class="sc-faq-foot">
        <label class="sc-inline">Category <select class="form-input" value=${it.category} onChange=${(e) => onMove(e.target.value)}>${cats.map(x => html`<option value=${x.id}>${x.label || 'Untitled'}</option>`)}</select></label>
        <button type="button" class="btn btn-ghost btn-sm" onClick=${onToggle}>Done</button>
      </div>
    </div>`;
}

// ─── Media kit ─────────────────────────────────────────────────────
const BRANDING_SPEC = { ratio: 3 / 2, crop: 'face', label: 'Photo', where: 'In the press photo grid; downloads at full size' };
function MediaPage({ c }) {
  const m = c.doc('media');
  const set = (p) => (v) => c.set('media', p, v);
  const bio = m.bio || {};
  const story = String(m.founderStory || '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
  const photos = Array.isArray(m.brandingPhotos) ? m.brandingPhotos : [];
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); c.addToast('Copied.', 'success'); } catch { c.addToast('Couldn’t copy.', 'error'); } };
  return html`
    <${Card} title="Organization bio" sub="Facts at the top of the press page, at /branding/.">
      <div class="sc-pair">
        <${TextField} label="Name" value=${bio.orgName} onChange=${set('bio.orgName')} max=${80} />
        <${TextField} label="Founded" value=${bio.founded} onChange=${set('bio.founded')} max=${20} />
        <${TextField} label="Founders" value=${bio.founders} onChange=${set('bio.founders')} max=${80} />
        <${TextField} label="Location" value=${bio.location} onChange=${set('bio.location')} max=${60} />
        <${TextField} label="EIN" value=${bio.ein} onChange=${set('bio.ein')} problem=${S.einProblem(bio.ein)} />
        <${TextField} label="Website" value=${bio.website} onChange=${set('bio.website')} max=${60} hint="Shown as text, not a link." />
      </div>
      <${AreaField} label="One-line bio for press" value=${bio.boilerplate} onChange=${set('bio.boilerplate')} rows=${2} max=${300} hint=${html`Has a copy button on the page. <button type="button" class="sc-link" onClick=${() => copy(bio.boilerplate || '')}>Copy it</button>`} />
    <//>
    <${Card} title="Mission and who we are">
      <${AreaField} label="Mission statement" value=${m.mission} onChange=${set('mission')} rows=${3} max=${600} />
      <${AreaField} label="Who we are" value=${m.who} onChange=${set('who')} rows=${3} max=${600} />
    <//>
    <${Card} title="Founders’ story" sub="Plain paragraphs, no formatting.">
      <${ListEditor} items=${story} label="paragraph" addToast=${c.addToast} onChange=${(list) => set('founderStory')(list.join('\n\n'))} make=${() => ''} addLabel="Add a paragraph"
        renderItem=${(p, i, up) => html`<${AreaField} label=${`Paragraph ${i + 1}`} value=${p} onChange=${(v) => up(() => v.replace(/\n{2,}/g, '\n'))} rows=${3} />`} />
    <//>
    <${Card} title="Press photos" sub="Up to 8. Reporters can download each one, or all at once. Changing the order changes the download links until you publish.">
      <${ListEditor} items=${photos} label="photo" max=${8} addToast=${c.addToast} onChange=${set('brandingPhotos')} make=${() => ({ kidSlug: '', cfId: '', caption: '' })} addLabel="Add a photo"
        renderItem=${(p, i, up) => html`
          <div class="sc-mile">
            <${PhotoField} compact path=${`brandingPhotos.${i}.cfId`} spec=${BRANDING_SPEC} value=${p.cfId} onChange=${(v) => up({ cfId: v })} kids=${c.kids} kidSlug=${p.kidSlug || null} />
            <div class="sc-stack">
              <${KidPicker} label="Who’s in it" value=${p.kidSlug || ''} kids=${c.kids} blankLabel="Not a kid’s photo"
                onChange=${(slug) => { const k = c.kids.find(x => x.slug === slug); up({ kidSlug: slug, ...(k && !p.cfId ? { cfId: heroIdOf(c.kids, slug) } : {}), ...(k && !p.caption ? { caption: [k.name, k.diagnosis].filter(Boolean).join(', ') } : {}) }); }} />
              <${TextField} label="Caption" value=${p.caption} onChange=${(v) => up({ caption: v })} max=${120} hint="Shown under the photo and read by screen readers." />
            </div>
          </div>`} />
    <//>
    <${Card} title="Contact and social">
      <div class="sc-pair">
        <${TextField} label="Press email" value=${m.contactEmail} onChange=${set('contactEmail')} type="email" problem=${S.emailProblem(m.contactEmail)} />
        <${TextField} label="Facebook" value=${m.socialLinks?.facebook} onChange=${set('socialLinks.facebook')} problem=${S.urlProblem(m.socialLinks?.facebook)} inputmode="url" />
        <${TextField} label="Instagram" value=${m.socialLinks?.instagram} onChange=${set('socialLinks.instagram')} problem=${S.urlProblem(m.socialLinks?.instagram)} inputmode="url" />
        <${TextField} label="YouTube" value=${m.socialLinks?.youtube} onChange=${set('socialLinks.youtube')} problem=${S.urlProblem(m.socialLinks?.youtube)} inputmode="url" />
      </div>
    <//>
    <${Card} title="Search engines" sub="The page’s description in Google results and link previews.">
      <${AreaField} label="Description" value=${m.metaDescription} onChange=${set('metaDescription')} rows=${2} max=${160} />
    <//>`;
}

// ─── Sunny & Ranney ────────────────────────────────────────────────
const BUILT_IN_ROOMS = [{ cfId: 'kids/griffin/hero', label: 'Dream Bedroom' }, { cfId: 'kids/jackson/hero', label: 'Therapy Room' }, { cfId: 'kids/madison/hero', label: 'Sensory Space' }];
const ROOM_SPEC = { ratio: 5 / 4, crop: 'center', label: 'Photo' };
function StorePage({ c }) {
  const rooms = (c.doc('settings').sunnyAndRanneyRooms || []);
  const using = rooms.filter(r => r?.cfId).length > 0;
  return html`
    <${Card} title="Room cards" sub="“Rooms we’ve built”: furnished rooms on the Sunny & Ranney page.">
      ${!using && html`
        <p class="sc-note">The page shows these three built-in cards.</p>
        <div class="sc-photos cols-3">${BUILT_IN_ROOMS.map(r => html`<figure class="sc-mini"><img src=${imgUrl(r.cfId, 'w=400,h=320,fit=cover,q=70')} alt="" loading="lazy" /><figcaption>${r.label}</figcaption></figure>`)}</div>
        <button type="button" class="btn btn-ghost btn-sm sc-add" onClick=${() => c.set('settings', 'sunnyAndRanneyRooms', S.clone(BUILT_IN_ROOMS))}>Change these</button>`}
      ${using && html`
        <${ListEditor} items=${rooms} label="room" addToast=${c.addToast} onChange=${(v) => c.set('settings', 'sunnyAndRanneyRooms', v)} make=${() => ({ cfId: '', label: '' })} addLabel="Add a room"
          renderItem=${(r, i, up) => html`
            <div class="sc-mile">
              <${PhotoField} compact path=${`sunnyAndRanneyRooms.${i}.cfId`} spec=${ROOM_SPEC} value=${r.cfId} onChange=${(v) => up({ cfId: v })} kids=${c.kids} />
              <${TextField} label="Room" value=${r.label} onChange=${(v) => up({ label: v })} max=${40} placeholder="Dream Bedroom" problem=${!String(r.label || '').trim() ? 'Name the room' : null} />
            </div>`} />`}
    <//>`;
}

// ─── Across the site ───────────────────────────────────────────────
function OrgPage({ c }) {
  const st = c.doc('settings');
  const set = (p) => (v) => c.set('settings', p, v);
  const a = st.address || {};
  return html`
    <${Card} title="Organization" sub="Used across the site and the legal pages.">
      <div class="sc-pair">
        <${TextField} label="Name" value=${st.name} onChange=${set('name')} max=${80} problem=${!String(st.name || '').trim() ? 'The name is required' : null} hint="Donate, Ways to Give, Advisory Board, legal pages." />
        <${TextField} label="EIN" value=${st.ein} onChange=${set('ein')} problem=${S.einProblem(st.ein)} hint="Donate (with a copy button), Ways to Give, legal pages." />
        <${TextField} label="Short name" value=${st.shortName} onChange=${set('shortName')} max=${20} hint="The Terms page." />
        <${TextField} label="Tagline" value=${st.tagline} onChange=${set('tagline')} max=${80} hint="The Terms page." />
      </div>
    <//>
    <${Card} title="Phone and email" sub="In the footer of every page, and wherever people are asked to get in touch.">
      <div class="sc-pair">
        <${TextField} label="Phone" value=${st.phone} onChange=${set('phone')} type="tel" autocomplete="tel" problem=${S.phoneProblem(st.phone)} hint="Shown as typed; tapping it calls." />
        <${TextField} label="Email" value=${st.email} onChange=${set('email')} type="email" problem=${S.emailProblem(st.email)} hint="Footer, Apply, the application form, Ways to Give, Advisory Board." />
      </div>
    <//>
    <${Card} title="Address" sub="Footer (with a map link), Donate, Ways to Give, legal pages.">
      <${TextField} label="Street" value=${a.street} onChange=${set('address.street')} max=${80} wide />
      <div class="sc-trio">
        <${TextField} label="City" value=${a.city} onChange=${set('address.city')} max=${40} />
        <${TextField} label="State" value=${a.state} onChange=${(v) => set('address.state')(v.toUpperCase().slice(0, 2))} max=${2} />
        <${TextField} label="ZIP" value=${a.zip} onChange=${set('address.zip')} inputmode="numeric" problem=${S.zipProblem(a.zip)} />
      </div>
    <//>`;
}

const SOCIALS = [['facebook', 'Facebook', 'https://www.facebook.com/…'], ['instagram', 'Instagram', 'https://www.instagram.com/…'], ['youtube', 'YouTube', 'https://www.youtube.com/@…'], ['tiktok', 'TikTok', 'https://www.tiktok.com/@…']];
function SocialPage({ c }) {
  const so = c.doc('settings').social || {};
  return html`
    <${Card} title="Social links" sub="Icons in the footer of every page; Facebook and Instagram also on Apply. A blank one is left out.">
      ${SOCIALS.map(([k, label, ph]) => html`
        <div class="sc-social">
          <${TextField} label=${label} value=${so[k]} onChange=${(v) => c.set('settings', `social.${k}`, v)} placeholder=${ph} problem=${S.urlProblem(so[k])} inputmode="url" />
          ${so[k] && !S.urlProblem(so[k]) && html`<a class="btn btn-ghost btn-sm" href=${so[k]} target="_blank" rel="noopener">Open <${Icon} name="ext" size=${12} /></a>`}
        </div>`)}
    <//>`;
}

/** SVG badges become 512px PNGs: Cloudflare won't resize an SVG and can strip its artwork */
const svgToPng = (file, size = 512) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const im = new Image();
  im.onload = () => {
    try {
      const w0 = im.naturalWidth || size;
      const h0 = im.naturalHeight || size;
      const k = size / Math.max(w0, h0);
      const cv = document.createElement('canvas');
      cv.width = Math.round(w0 * k);
      cv.height = Math.round(h0 * k);
      cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
      cv.toBlob((b) => { URL.revokeObjectURL(url); b ? resolve(new File([b], file.name.replace(/\.svg$/i, '') + '.png', { type: 'image/png' })) : reject(new Error('Could not convert the SVG')); }, 'image/png');
    } catch (e) { URL.revokeObjectURL(url); reject(e); }
  };
  im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the SVG')); };
  im.src = url;
});
const badgeSrc = (image) => (!image ? '' : /^(\/|https?:|blob:)/.test(image) && !/imagedelivery/.test(image) ? image : imgUrl(image, 'w=160,h=160,fit=contain'));

function BadgesPage({ c }) {
  const st = c.doc('settings');
  const saved = Array.isArray(st.trustBadges);
  const badges = saved ? st.trustBadges : S.DEFAULT_TRUST_BADGES;
  const [busy, setBusy] = useState(-1);
  const setList = (v) => c.set('settings', 'trustBadges', v);
  const upload = async (i, file, up) => {
    if (!file) return;
    setBusy(i);
    try {
      const f = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name) ? await svgToPng(file) : file;
      const fd = new FormData();
      fd.append('file', f);
      fd.append('id', `badges/${String(badges[i]?.name || 'badge').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'badge'}-${Date.now()}`);
      const j = await call('/api/upload-image', fd);
      if (!j.success) throw new Error(j.error);
      up({ image: j.imageId });
    } catch (e) { c.addToast(`Couldn't upload: ${e.message}`, 'error'); }
    setBusy(-1);
  };
  return html`
    <${Card} title="Trust badges" sub="Rating seals in the footer of every page, and in the “Independently verified” row on Financials. When a new rating comes in, upload the badge they send (SVG or PNG) and update the rating.">
      ${!saved && html`<p class="sc-note">These are the built-in badges. Change anything and they’re saved as your list.</p>`}
      <${ListEditor} items=${badges} label="badge" addToast=${c.addToast} onChange=${setList} make=${() => ({ name: '', detail: '', url: '', image: '' })} addLabel="Add a badge"
        renderItem=${(b, i, up) => html`
          <div class="sc-badge">
            <div class="sc-badge-art">
              <span class="sc-badge-tile">${b.image ? html`<img src=${badgeSrc(b.image)} alt="" />` : html`<span>${b.name || 'No image'}</span>`}</span>
              <${FileButton} label=${b.image ? 'Replace' : 'Upload'} accept="image/svg+xml,image/png,image/jpeg,image/webp,.svg" busy=${busy === i} onFile=${(f) => upload(i, f, up)} />
            </div>
            <div class="sc-stack">
              <div class="sc-pair">
                <${TextField} label="Organization" value=${b.name} onChange=${(v) => up({ name: v })} placeholder="Charity Navigator" max=${40} problem=${!String(b.name || '').trim() ? 'Name it, or remove the badge' : null} />
                <${TextField} label="Rating" value=${b.detail} onChange=${(v) => up({ detail: v })} placeholder="4-Star Rating" max=${40} hint="“Star” in it shows a star on Financials." />
              </div>
              <${TextField} label="Profile link" value=${b.url} onChange=${(v) => up({ url: v })} placeholder="https://" problem=${S.urlProblem(b.url)} inputmode="url" optional />
            </div>
          </div>`} />
    <//>`;
}

function NewsletterPage() {
  const [kit, setKit] = useState(null);
  useEffect(() => { call('/api/kit-status').then(d => setKit(!!(d.ok && d.configured))).catch(() => setKit(false)); }, []);
  return html`
    <${Card} title="Newsletter" sub="Signups from the site go to Kit, tagged by the form they used. Write and send newsletters in Kit, and choose who gets each one there.">
      ${kit === null ? html`<p class="sc-hint">Checking Kit…</p>`
        : kit ? html`<p class="sc-callout is-open"><span class="sc-dot" aria-hidden="true"></span><span>Kit is connected. New subscribers land there.</span></p>`
          : html`<p class="sc-callout"><span class="sc-dot" aria-hidden="true"></span><span>Kit isn’t connected. Set <code>KIT_API_KEY</code> in the Cloudflare Pages dashboard; until then the site can’t save signups.</span></p>`}
    <//>`;
}

// ─── What must be fixed before saving, per page ────────────────────
const PROBLEMS = {
  home: (d) => { const h = d.settings?.homeHero || {}; const up = d.settings?.upNext || {}; return [S.linkProblem(h.cta1Link) && 'the first hero button’s link', S.linkProblem(h.cta2Link) && 'the second hero button’s link', up.mode === 'manual' && S.linkProblem(up.ctaLink) && 'the Up Next button’s link'].filter(Boolean); },
  apply: (d) => ((d.settings?.applyFaqs || []).some(q => !String(q.question || '').trim() || !S.plainText(q.answer)) ? ['a question without its words'] : []),
  faq: (d) => [(d.faq?.categories || []).some(x => !String(x.label || '').trim()) && 'a category without a name', (d.faq?.items || []).some(i => !String(i.question || '').trim() || !S.plainText(i.answer)) && 'a question without its words'].filter(Boolean),
  about: (d) => ((d['our-story']?.milestones || []).some(m => !/^\d{4}$/.test(String(m.year || '')) || !String(m.title || '').trim()) ? ['a timeline milestone without its year or title'] : []),
  financials: (d) => [(d.financials?.documents || []).some(x => !/^\d{4}$/.test(String(x.year || '')) || !x.url) && 'a document without its year or file', (d.financials?.annualReports || []).some(x => !/^\d{4}$/.test(String(x.year || ''))) && 'an annual report without its year'].filter(Boolean),
  media: (d) => { const m = d.media || {}; return [S.einProblem(m.bio?.ein) && 'the EIN', S.emailProblem(m.contactEmail) && 'the press email', ['facebook', 'instagram', 'youtube'].some(k => S.urlProblem(m.socialLinks?.[k])) && 'a social link'].filter(Boolean); },
  store: (d) => ((d.settings?.sunnyAndRanneyRooms || []).some(r => r && (!r.cfId || !String(r.label || '').trim())) ? ['a room card without its photo or name'] : []),
  org: (d) => { const st = d.settings || {}; return [!String(st.name || '').trim() && 'the organization name', S.einProblem(st.ein) && 'the EIN', S.phoneProblem(st.phone) && 'the phone number', S.emailProblem(st.email) && 'the email', S.zipProblem(st.address?.zip) && 'the ZIP code'].filter(Boolean); },
  social: (d) => (SOCIALS.some(([k]) => S.urlProblem(d.settings?.social?.[k])) ? ['a social link'] : []),
  badges: (d) => (Array.isArray(d.settings?.trustBadges) && d.settings.trustBadges.some(b => !String(b.name || '').trim() || S.urlProblem(b.url)) ? ['a badge’s name or link'] : []),
};

const VIEWS = { home: HomePage, kids: KidsPage, how: HowPage, apply: ApplyPage, donate: DonatePage, ways: WaysPage, partners: PartnersPage, community: CommunityPage, resources: ResourcesPage, about: AboutPage, financials: FinancialsPage, faq: FaqPage, advisory: AdvisoryPage, store: StorePage, media: MediaPage, org: OrgPage, social: SocialPage, badges: BadgesPage, newsletter: NewsletterPage };
const KEYWORDS = {
  home: 'hero headline button eyebrow paragraph up next now building featured story kid strip showcase mission rooms bathroom bedroom therapy',
  kids: 'summary line title', how: 'project drawings plans reveal video', apply: 'applications open closed photos journey quote testimonial questions faq meet family',
  donate: 'hero story family questions', ways: 'photos legacy break', partners: 'quote testimonial hero', community: 'hero accent', resources: 'guides articles why',
  about: 'our story founders tripp turning point gracie mascot store timeline milestones today closing', financials: '990 tax return audit annual report numbers revenue expenses programs net assets volunteers employees',
  faq: 'questions answers categories donate star', advisory: 'hero', store: 'sunny ranney rooms cards', media: 'press branding bio boilerplate mission photos download',
  org: 'name ein phone email address street city zip contact', social: 'facebook instagram youtube tiktok', badges: 'charity navigator candid guidestar rating seal footer', newsletter: 'kit signups subscribers',
};

const readHash = () => { const m = String(location.hash).match(/^#site(?:\/([\w-]+))?/); return m ? (S.pageByKey(m[1]) ? m[1] : null) : undefined; };

// ─── The area ──────────────────────────────────────────────────────
export function SiteConfigArea({ addToast = () => {}, setGlobalDirty = null, onPublish = null, kids = [], partners = [], initialTab = null }) {
  injectStyles();
  const narrow = useNarrow();
  const docs = useDocs(addToast);
  const [pageKey, setPageKey] = useState(() => readHash() || S.OLD_TABS[initialTab] || (S.pageByKey(initialTab) ? initialTab : null));
  const key = pageKey || (narrow ? null : 'home');
  const page = S.pageByKey(key);
  const [showHistory, setShowHistory] = useState(false);
  const [pending, setPending] = useState(null);
  const mainRef = useRef(null);

  useEffect(() => { if (page) docs.ensure(page.docs); }, [key]);
  // FAQ and the snapshot are read by other pages' panels; load them quietly
  useEffect(() => { docs.ensure(['faq', 'financial-snapshot']); }, []);
  // The command palette (and old links) ask for a page by name
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const k = S.OLD_TABS[initialTab] || initialTab;
    if (S.pageByKey(k)) go(k);
  }, [initialTab]);
  useEffect(() => {
    const on = () => { const k = readHash(); if (k !== undefined) setPageKey(k); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const go = (k, anchor = null) => {
    setPageKey(k);
    history.replaceState?.(null, '', k ? `#site/${k}` : '#site');
    requestAnimationFrame(() => {
      if (anchor) { document.getElementById(anchor)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }); return; }
      const scroller = mainRef.current?.closest('.main') || document.scrollingElement;
      scroller?.scrollTo?.({ top: 0 });
      if (narrow) mainRef.current?.querySelector('h2')?.focus?.();
    });
  };
  const c = {
    doc: (k) => docs.docs[k]?.edit || {},
    set: docs.set, update: docs.update,
    photo: (path, v) => docs.update('settings', (e) => S.withPhoto(e, path, v)),
    kids, partners, addToast, go,
    open: (view, hash = null) => { if (hash) history.replaceState?.(null, '', hash); window.dispatchEvent(new CustomEvent('soard-navigate', { detail: view })); },
  };

  const edits = Object.fromEntries(Object.entries(docs.docs).map(([k, v]) => [k, v.edit]));
  const changed = S.PAGES.filter(p => S.pageChanges(p, docs.docs).length);
  const problemsOf = (p) => (PROBLEMS[p.key] && p.docs.every(k => docs.docs[k]?.edit) ? PROBLEMS[p.key](edits) : []);
  const blocking = changed.map(p => ({ page: p, list: problemsOf(p) })).filter(x => x.list.length);
  const dirty = docs.dirtyKeys.length > 0;

  useEffect(() => { setGlobalDirty?.(dirty, 'Site Config'); return () => setGlobalDirty?.(false); }, [dirty]);
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const save = async () => {
    if (blocking.length) { addToast(`Fix ${blocking[0].list[0]} on ${blocking[0].page.title} first.`, 'error'); go(blocking[0].page.key); return false; }
    const ok = await docs.save();
    if (ok) loadPending();
    return ok;
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const fn = () => saveRef.current();
    window.addEventListener('soard-save', fn);
    return () => window.removeEventListener('soard-save', fn);
  }, []);

  // Which documents are saved but not on the live site yet (Publish to site)
  const loadPending = async () => { const j = await call('/api/pending-changes'); if (j.success) setPending(j.changes || []); };
  useEffect(() => { loadPending(); const on = () => setTimeout(loadPending, 600); window.addEventListener('soard-content-changed', on); return () => window.removeEventListener('soard-content-changed', on); }, []);
  const waiting = page && pending ? pending.filter(x => page.docs.includes(x.type)) : [];
  useEffect(() => { if (!waiting.length) return undefined; const t = setInterval(loadPending, 30000); return () => clearInterval(t); }, [waiting.length]);

  return html`
    <div class="sc-root sc-area ${key ? 'has-page' : 'is-list'}">
      <${Rail} current=${key} changed=${changed} onPick=${go} />
      <div class="sc-main" ref=${mainRef}>
        ${page && html`
          <${SaveBar} page=${page} changed=${changed} blocking=${blocking} saving=${docs.saving} dirty=${dirty} waiting=${waiting}
            onSave=${save} onDiscard=${() => { docs.discard(); addToast('Changes discarded.', 'info'); }} onHistory=${() => setShowHistory(true)} onPublish=${onPublish} onBack=${() => go(null)} go=${go} />
          <${PageBody} page=${page} c=${c} docs=${docs} problems=${problemsOf(page)} />`}
      </div>
      ${showHistory && page && html`<${HistoryDialog} page=${page} docs=${docs} onClose=${() => setShowHistory(false)} addToast=${addToast} />`}
      ${docs.conflict && html`<${ConflictDialog} clashes=${docs.conflict} onResolve=${docs.resolve} onClose=${docs.cancelConflict} />`}
    </div>`;
}

function Rail({ current, changed, onPick }) {
  const [q, setQ] = useState('');
  const words = q.trim().toLowerCase();
  const match = (p) => !words || `${p.title} ${p.blurb} ${KEYWORDS[p.key] || ''} ${p.url}`.toLowerCase().includes(words);
  const group = (g, title) => {
    const list = S.PAGES.filter(p => p.group === g && match(p));
    if (!list.length) return null;
    return html`
      <h2 class="sc-rail-group">${title}</h2>
      <ul class="sc-rail-list">
        ${list.map(p => html`
          <li><a href=${`#site/${p.key}`} class=${current === p.key ? 'is-on' : ''} aria-current=${current === p.key ? 'page' : null}
            onClick=${(e) => { e.preventDefault(); onPick(p.key); }}>
            <span class="sc-rail-title">${p.title}${changed.some(x => x.key === p.key) && html`<span class="sc-dirty" title="Unsaved changes" aria-label="Unsaved changes"></span>`}</span>
            <span class="sc-rail-sub">${p.group === 'pages' && p.url !== '/' ? `${p.url} · ` : ''}${p.blurb}</span>
          </a></li>`)}
      </ul>`;
  };
  return html`
    <nav class="sc-rail" aria-label="Site Config">
      <div class="sc-rail-head">
        <h1 class="sc-rail-h">Site Config</h1>
        <p class="sc-rail-lede">What each public page says and shows, page by page.</p>
        <label class="sc-search"><${Icon} name="search" /><input value=${q} placeholder="Find a page or setting" aria-label="Find a page or setting" onInput=${(e) => setQ(e.target.value)} /></label>
      </div>
      ${group('pages', 'Pages')}
      ${group('site', 'Across the site')}
      ${words && !S.PAGES.some(match) && html`<p class="sc-hint sc-rail-none">Nothing matches “${q}”.</p>`}
    </nav>`;
}

function SaveBar({ page, changed, blocking, saving, dirty, waiting, onSave, onDiscard, onHistory, onPublish, onBack, go }) {
  const others = changed.filter(p => p.key !== page.key);
  const here = changed.some(p => p.key === page.key);
  const fix = blocking[0];
  const hasHistory = page.docs.some(k => page.fields?.[k]);
  return html`
    <div class="sc-bar" data-state=${saving ? 'saving' : dirty ? 'dirty' : waiting.length ? 'waiting' : 'saved'}>
      <button type="button" class="sc-icon-btn sc-back" aria-label="All pages" onClick=${onBack}><${Icon} name="back" /></button>
      <div class="sc-bar-title">
        <h2 tabindex="-1">${page.title}</h2>
        <span class="sc-bar-state" role="status" aria-live="polite">
          ${saving ? 'Saving…'
            : fix ? html`<span class="sc-bad">Fix ${fix.list[0]}${fix.page.key !== page.key ? html` on <button type="button" class="sc-link" onClick=${() => go(fix.page.key)}>${fix.page.title}</button>` : ''} to save</span>`
              : dirty ? html`Unsaved changes${here ? ' here' : ''}${others.length ? html`${here ? ' and on ' : ' on '}${others.map((p, i) => html`${i ? ', ' : ''}<button type="button" class="sc-link" onClick=${() => go(p.key)}>${p.title}</button>`)}` : ''}`
                : waiting.length ? html`Saved. On the site after you publish${onPublish ? html` · <button type="button" class="sc-link" onClick=${onPublish}>Publish now</button>` : ''}`
                  : 'Everything is saved and live'}
        </span>
      </div>
      <div class="sc-bar-actions">
        ${page.url && page.group === 'pages' && html`<a class="btn btn-ghost btn-sm sc-hide-sm" href=${page.url} target="_blank" rel="noopener">View page <${Icon} name="ext" size=${12} /></a>`}
        ${hasHistory && html`<button type="button" class="btn btn-ghost btn-sm" onClick=${onHistory}><${Icon} name="history" size=${14} /> <span class="sc-hide-xs">History</span></button>`}
        ${dirty && html`<button type="button" class="btn btn-ghost btn-sm" disabled=${saving} onClick=${onDiscard}>Discard</button>`}
        <button type="button" class="btn btn-primary btn-sm" disabled=${!dirty || saving || !!fix} onClick=${onSave}>${saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>`;
}

function PageBody({ page, c, docs, problems }) {
  const states = page.docs.map(k => docs.docs[k]);
  const failed = page.docs.filter(k => docs.docs[k]?.status === 'error');
  if (failed.length) return html`
    <div class="card sc-card">
      <p class="sc-bad" style="margin: 0 0 .5rem;">Couldn’t load this page’s settings: ${docs.docs[failed[0]].error}</p>
      <p class="sc-hint" style="margin: 0 0 1rem;">Nothing here can be changed until it loads, so nothing gets overwritten.</p>
      <button type="button" class="btn btn-ghost" onClick=${() => failed.forEach(k => docs.load(k))}>Try again</button>
    </div>`;
  if (states.some(s => !s || s.status !== 'ready')) return html`<div class="sc-spin"><span class="spinner" /></div>`;
  const View = VIEWS[page.key];
  return html`
    <div class="sc-page">
      ${problems.length > 0 && html`<p class="sc-note is-warn" role="alert"><${Icon} name="warn" /> Before saving, fix ${problems.join(', ')}.</p>`}
      <${View} c=${c} />
    </div>`;
}

/** Earlier versions of this page's documents: compare with now, put this page's fields back */
function HistoryDialog({ page, docs, onClose, addToast }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  const mine = page.docs.filter(k => page.fields?.[k]);
  const tops = (k) => (page.fields[k] || []).map(f => f.split('.')[0]);
  useEffect(() => {
    Promise.all(mine.map(k => call(`/api/content-history?collection=site&slug=${encodeURIComponent(k)}`).then(j => ({ k, j })))).then((rs) => {
      const bad = rs.find(r => !r.j.success);
      if (bad) { setErr(bad.j.error || 'Couldn’t load the history'); return; }
      const out = [];
      for (const { k, j } of rs) {
        const fields = page.fields[k];
        for (const v of j.versions || []) {
          const hit = fields.includes('') || !v.changed || v.changed.some(t => tops(k).includes(t));
          if (hit) out.push({ ...v, doc: k });
        }
      }
      out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      setRows(out);
    });
  }, []);
  const compare = async (row) => {
    setOpen({ row, loading: true });
    const j = await call(`/api/content-history?collection=site&slug=${encodeURIComponent(row.doc)}&id=${row.id}`);
    if (!j.success) { setOpen({ row, error: j.error || 'That version is gone' }); return; }
    const now = docs.docs[row.doc]?.edit || {};
    const fields = page.fields[row.doc];
    const diffs = S.changedPaths(now, j.data).filter(p => p !== 'photoTimestamps' && (fields.includes('') || S.touches(p, fields)));
    setOpen({ row, data: j.data, diffs });
  };
  const restore = () => {
    const { row, data, diffs } = open;
    docs.update(row.doc, (e) => diffs.reduce((acc, p) => S.setPath(acc, p, S.clone(S.getPath(data, p))), e));
    addToast(`Put back ${diffs.length} ${diffs.length === 1 ? 'thing' : 'things'} from ${when(row.at)}. Save to keep them.`, 'success');
    onClose();
  };
  return html`
    <${Dialog} title=${`${page.title}: history`} sub="Every save is kept. Compare one with now, then put this page’s parts back." wide onClose=${onClose}
      footer=${open?.diffs ? html`<button type="button" class="btn btn-ghost" onClick=${() => setOpen(null)}>Back</button><button type="button" class="btn btn-primary" disabled=${!open.diffs.length} onClick=${restore}>Put these back</button>` : html`<button type="button" class="btn btn-ghost" onClick=${onClose}>Close</button>`}>
      ${err && html`<p class="sc-bad">${err}</p>`}
      ${!rows && !err && html`<div class="sc-spin"><span class="spinner" /></div>`}
      ${rows && !open && html`
        ${!rows.length && html`<p class="sc-empty">No saves yet. From now on every save is kept here.</p>`}
        <ol class="sc-hist">
          ${rows.map((r, i) => html`
            <li key=${`${r.doc}-${r.id}`}>
              <div><strong>${when(r.at)}</strong><span class="sc-hint">${r.by ? personName(r.by) : i === rows.length - 1 ? 'Before history began' : 'Someone'}${r.changed?.length ? ` · ${[...new Set(r.changed.filter(t => page.fields[r.doc].includes('') || tops(r.doc).includes(t)).map(labelOf))].join(', ')}` : ''}</span></div>
              <button type="button" class="btn btn-ghost btn-sm" onClick=${() => compare(r)}>Compare with now</button>
            </li>`)}
        </ol>`}
      ${open && html`
        ${open.loading && html`<div class="sc-spin"><span class="spinner" /></div>`}
        ${open.error && html`<p class="sc-bad">${open.error}</p>`}
        ${open.diffs && html`
          <p class="sc-hint" style="margin-top:0">From ${when(open.row.at)}${open.row.by ? ` by ${personName(open.row.by)}` : ''}.</p>
          ${!open.diffs.length ? html`<p class="sc-empty">Nothing on this page is different from now.</p>` : html`
            <ul class="sc-diff">${open.diffs.map(p => html`<li key=${p}><strong>${labelOf(p)}</strong><span class="sc-diff-then">Then: ${valueText(S.getPath(open.data, p))}</span><span class="sc-diff-now">Now: ${valueText(S.getPath(docs.docs[open.row.doc]?.edit, p))}</span></li>`)}</ul>`}`}`}
    <//>`;
}

/** Someone saved the same fields meanwhile: choose for each, then save */
function ConflictDialog({ clashes, onResolve, onClose }) {
  const [choice, setChoice] = useState({});
  const all = clashes.flatMap(c => c.paths.map(p => ({ c, p, id: `${c.key}:${p}` })));
  return html`
    <${Dialog} title="Someone else changed the same things" sub="While you were editing, these were saved by someone else. Pick which to keep for each; everything else you changed saves as is." wide onClose=${onClose}
      footer=${html`<button type="button" class="btn btn-ghost" onClick=${onClose}>Cancel</button><button type="button" class="btn btn-primary" onClick=${() => onResolve(choice)}>Save with these</button>`}>
      <ul class="sc-diff">
        ${all.map(({ c, p, id }) => html`
          <li key=${id}>
            <strong>${S.pageOf(c.key, p)?.title ? `${S.pageOf(c.key, p).title}: ` : ''}${labelOf(p)}</strong>
            <label class="sc-check"><input type="radio" name=${id} checked=${choice[id] !== 'theirs'} onChange=${() => setChoice(x => ({ ...x, [id]: 'mine' }))} /> Keep mine: <q>${valueText(S.getPath(c.mine, p))}</q></label>
            <label class="sc-check"><input type="radio" name=${id} checked=${choice[id] === 'theirs'} onChange=${() => setChoice(x => ({ ...x, [id]: 'theirs' }))} /> Use theirs: <q>${valueText(S.getPath(c.theirs, p))}</q></label>
          </li>`)}
      </ul>
    <//>`;
}

// ─── Styles (admin tokens only, so a dark theme carries over) ──────
const CSS = `
.sc-area { display: grid; grid-template-columns: 264px minmax(0, 1fr); gap: 1.5rem; align-items: start; }
.sc-root .sc-ico { display: block; flex-shrink: 0; }
.sc-root .card { margin: 0; overflow: visible; }
.sc-hint { font-size: var(--fs-xs); color: var(--color-text-muted); line-height: 1.45; }
.sc-sub { margin: .2rem 0 0; font-size: var(--fs-sm); color: var(--color-text-secondary); line-height: 1.5; }
.sc-bad { color: var(--color-danger); font-size: var(--fs-xs); line-height: 1.4; }
.sc-muted { color: var(--color-text-muted); }
.sc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs); }
.sc-link { padding: 0; border: 0; background: none; color: inherit; font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.sc-link:hover { color: var(--color-text); }
.sc-count { display: inline-block; min-width: 1.4rem; padding: 0 .4rem; border-radius: 999px; background: color-mix(in srgb, var(--color-text) 7%, transparent); color: var(--color-text-secondary); font-size: var(--fs-2xs); font-weight: 700; line-height: 1.35rem; text-align: center; }
.sc-count.is-over { background: color-mix(in srgb, var(--color-danger) 14%, transparent); color: var(--color-danger); }
.sc-chip { display: inline-flex; align-items: center; gap: .3rem; padding: .1rem .55rem; border-radius: 999px; background: color-mix(in srgb, var(--color-text) 7%, transparent); color: var(--color-text-secondary); font-size: var(--fs-2xs); font-weight: 600; white-space: nowrap; }
.sc-chip.is-warn { background: color-mix(in srgb, var(--color-warning) 18%, transparent); color: color-mix(in srgb, var(--color-warning) 55%, var(--color-text)); }
.sc-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex-shrink: 0; padding: 0; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
.sc-icon-btn:hover:not(:disabled) { background: var(--color-bg-hover); border-color: var(--color-border); color: var(--color-text); }
.sc-icon-btn:disabled { opacity: .3; cursor: default; }
.sc-spin { display: flex; justify-content: center; padding: 3rem; }
.sc-empty { padding: .6rem 0; color: var(--color-text-muted); font-size: var(--fs-sm); }
.sc-note { display: block; margin: .25rem 0 1rem; padding: .7rem .85rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-secondary); font-size: var(--fs-sm); line-height: 1.5; color: var(--color-text-secondary); }
.sc-note.is-warn { border-color: color-mix(in srgb, var(--color-warning) 45%, var(--color-border)); background: color-mix(in srgb, var(--color-warning) 10%, var(--color-bg-card)); color: var(--color-text); }
.sc-note > .sc-ico { display: inline-block; vertical-align: -3px; margin-right: .35rem; }

/* Rail */
.sc-rail { position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow: auto; padding: .25rem .25rem 1rem 0; overscroll-behavior: contain; }
.sc-rail-h { margin: 0; font-size: var(--fs-xl); letter-spacing: -.01em; }
.sc-rail-lede { margin: .2rem 0 .85rem; font-size: var(--fs-xs); color: var(--color-text-secondary); line-height: 1.45; }
.sc-rail-group { margin: 1.1rem 0 .35rem; padding-left: .6rem; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--color-text-muted); }
.sc-rail-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.sc-rail-list a { position: relative; display: grid; gap: .05rem; padding: .5rem .65rem; border-radius: 9px; color: var(--color-text); text-decoration: none; }
.sc-rail-list a:hover { background: var(--color-bg-hover); }
.sc-rail-list a.is-on { background: var(--color-bg-card); box-shadow: inset 3px 0 0 var(--color-primary), var(--shadow-xs); }
.sc-rail-list a:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.sc-rail-title { display: flex; align-items: center; gap: .45rem; font-weight: 600; font-size: var(--fs-sm); }
.sc-rail-sub { font-size: var(--fs-2xs); color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-rail-none { padding: .5rem .6rem; }
.sc-dirty { width: 8px; height: 8px; border-radius: 50%; background: var(--color-warning); flex-shrink: 0; }
.sc-search { display: flex; align-items: center; gap: .45rem; padding: 0 .7rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-card); color: var(--color-text-muted); }
.sc-search:focus-within { border-color: var(--color-border-strong); box-shadow: var(--focus-ring-strong); }
.sc-search input { flex: 1; min-width: 0; height: 38px; border: 0; outline: 0; background: transparent; color: var(--color-text); font: inherit; font-size: var(--fs-sm); }

/* Save bar */
.sc-main { min-width: 0; }
.sc-bar { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; gap: .75rem; margin-bottom: 1.25rem; padding: .7rem .8rem .7rem 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-bg-card) 92%, transparent); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); box-shadow: var(--shadow-xs); }
.sc-bar[data-state="dirty"] { border-color: color-mix(in srgb, var(--color-warning) 50%, var(--color-border)); }
.sc-bar-title { flex: 1; min-width: 0; display: grid; gap: .05rem; }
.sc-bar-title h2 { margin: 0; font-size: var(--fs-lg); letter-spacing: -.01em; }
.sc-root .sc-bar-title h2:focus { outline: none; box-shadow: none; }
.sc-bar-state { font-size: var(--fs-xs); color: var(--color-text-secondary); }
.sc-bar-actions { display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.sc-bar-actions .btn { display: inline-flex; align-items: center; gap: .35rem; }
.sc-back { display: none; }
@media (max-width: 1024px) { .sc-bar { top: var(--top-h); } }

/* Cards and fields */
.sc-page { display: grid; gap: 1.25rem; }
.sc-card { padding: 1.4rem 1.5rem 1.5rem; scroll-margin-top: 90px; }
.sc-card-head { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; margin-bottom: 1.15rem; }
.sc-card-head h3 { margin: 0; font-size: var(--fs-md); letter-spacing: -.005em; }
.sc-h4 { display: flex; align-items: center; gap: .45rem; margin: 1.4rem 0 .75rem; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--color-text-muted); }
.sc-stack { display: grid; gap: .25rem; align-content: start; min-width: 0; }
.sc-split { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(240px, 1fr); gap: 1.75rem; align-items: start; }
.sc-split.is-photo-first { grid-template-columns: minmax(200px, 300px) minmax(0, 1fr); }
.sc-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 1rem; align-items: start; }
.sc-pair.is-narrow-first { grid-template-columns: 7rem minmax(0, 1fr); }
.sc-trio { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 1rem; align-items: start; }
.sc-field { display: grid; gap: .35rem; margin-bottom: .9rem; min-width: 0; }
.sc-label { display: flex; align-items: baseline; gap: .4rem; font-weight: 600; font-size: var(--fs-xs); color: var(--color-text); }
.sc-opt { font-weight: 500; font-size: var(--fs-2xs); color: var(--color-text-muted); }
.sc-under { display: flex; justify-content: space-between; gap: .75rem; margin-top: -.05rem; }
.sc-root [aria-invalid="true"], .sc-rich.is-bad .sc-rich-text { border-color: var(--color-danger); }
.sc-area textarea.sc-area, .sc-root .sc-area { resize: vertical; line-height: 1.55; }
.sc-add { margin-top: .6rem; display: inline-flex; align-items: center; gap: .35rem; }
.sc-check { display: inline-flex; align-items: center; gap: .45rem; font-size: var(--fs-sm); cursor: pointer; }
.sc-check input { width: 18px; height: 18px; accent-color: var(--color-text); }
.sc-inline { display: inline-flex; align-items: center; gap: .5rem; font-size: var(--fs-xs); font-weight: 600; }
.sc-inline select { width: auto; }
.sc-seg { display: inline-flex; flex-wrap: wrap; gap: 2px; margin-bottom: 1rem; padding: 3px; border: 1px solid var(--color-border); border-radius: 11px; background: var(--color-bg-secondary); }
.sc-seg button { padding: .45rem .9rem; border: 0; border-radius: 8px; background: transparent; color: var(--color-text-secondary); font: inherit; font-size: var(--fs-xs); font-weight: 600; cursor: pointer; }
.sc-seg button.is-on { background: var(--color-bg-card); color: var(--color-text); box-shadow: var(--shadow-xs); }
.sc-seg button:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.sc-callout { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; margin: 0; padding: .85rem 1rem; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-bg-secondary); font-size: var(--fs-sm); }
.sc-callout > span:not(.sc-dot) { flex: 1 1 14rem; }
.sc-callout.is-open { border-color: color-mix(in srgb, var(--color-success) 35%, var(--color-border)); background: color-mix(in srgb, var(--color-success) 7%, var(--color-bg-card)); }
.sc-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--color-border-strong); flex-shrink: 0; }
.sc-callout.is-open .sc-dot { background: var(--color-success); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-success) 18%, transparent); }
.sc-links { list-style: none; margin: 0; padding: 0; display: grid; }
.sc-links li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .75rem 0; border-top: 1px solid var(--color-border); font-size: var(--fs-sm); color: var(--color-text-secondary); }
.sc-links li:first-child { border-top: 0; padding-top: 0; }
.sc-links li > span { display: inline-flex; align-items: center; gap: .35rem; flex-wrap: wrap; }
.sc-links .btn { flex-shrink: 0; }

/* Words with emphasis */
.sc-rich { position: relative; }
.sc-rich-text { min-height: 42px; height: auto; line-height: 1.55; white-space: normal; overflow-wrap: anywhere; cursor: text; }
.sc-rich-text:empty::before { content: attr(data-placeholder); color: var(--color-text-muted); pointer-events: none; }
.sc-rich-text em { font-style: italic; background-image: linear-gradient(transparent 55%, color-mix(in srgb, var(--color-primary) 45%, transparent) 55%); padding: 0 .05em; }
.sc-rich-text a { color: inherit; text-decoration: underline; text-decoration-color: var(--color-primary); text-decoration-thickness: 2px; text-underline-offset: 2px; }
.sc-rich.is-display .sc-rich-text { font-family: 'Libre Baskerville', Georgia, 'Times New Roman', serif; font-size: var(--fs-md); letter-spacing: -.01em; }
.sc-tools { position: absolute; bottom: calc(100% + 4px); right: 0; z-index: 5; display: flex; gap: 2px; padding: 3px; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-card); box-shadow: var(--shadow-sm); opacity: 0; pointer-events: none; transform: translateY(3px); transition: opacity .12s, transform .12s; }
.sc-rich.is-focus .sc-tools { opacity: 1; pointer-events: auto; transform: none; }
.sc-tool { min-width: 30px; height: 30px; padding: 0 .4rem; border: 0; border-radius: 7px; background: var(--color-bg-card); color: var(--color-text-secondary); font: inherit; font-size: var(--fs-xs); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.sc-tool:hover { color: var(--color-text); background: var(--color-bg-hover); }
.sc-tool-em em { background-image: linear-gradient(transparent 55%, color-mix(in srgb, var(--color-primary) 60%, transparent) 55%); }
.sc-linkbar { display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; margin-top: .4rem; padding: .5rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-secondary); }
.sc-linkbar .form-input { flex: 1 1 14rem; width: auto; }
.sc-paras { display: grid; gap: .45rem; }
.sc-para { display: grid; grid-template-columns: 1.4rem minmax(0, 1fr) auto; gap: .5rem; align-items: start; }
.sc-para .sc-field { margin: 0; }
.sc-para .sc-under { display: none; }
.sc-para-n { padding-top: .65rem; font-size: var(--fs-2xs); font-weight: 700; color: var(--color-text-muted); text-align: right; }
.sc-para-tools { display: flex; gap: 2px; padding-top: 5px; }

/* Lists */
.sc-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .55rem; }
.sc-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: .6rem; align-items: start; padding: .7rem .6rem .7rem .35rem; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-bg-card); }
.sc-row:focus-within { border-color: var(--color-border-strong); }
.sc-row .sc-field:last-child { margin-bottom: 0; }
.sc-grip { width: 26px; height: 36px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--color-text-muted); cursor: grab; display: inline-flex; align-items: center; justify-content: center; touch-action: none; }
.sc-grip:hover { color: var(--color-text); background: var(--color-bg-hover); }
.sc-grip:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.sc-row-tools { display: flex; gap: 2px; }
.sc-remove:hover:not(:disabled) { color: var(--color-danger); }
.sc-ghost { opacity: .35; }
.sc-chosen { box-shadow: var(--shadow-sm); }
.sc-kidrow { display: flex; align-items: center; gap: .75rem; min-height: 40px; }
.sc-kidrow > div { display: grid; flex: 1; min-width: 0; }
.sc-adding { display: flex; align-items: flex-end; gap: .5rem; margin-top: .75rem; padding: .75rem; border: 1px dashed var(--color-border-strong); border-radius: 12px; }
.sc-adding .sc-field { flex: 1; margin: 0; }
.sc-catrow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .25rem 1rem; align-items: center; }
.sc-catrow .sc-hint { grid-column: 1 / -1; margin-top: -.6rem; }
.sc-catrow .sc-field { margin-bottom: .6rem; }
.sc-mile { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 1rem; align-items: start; }

/* Kids */
.sc-avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; flex-shrink: 0; background: var(--color-bg-secondary); }
.sc-avatar.is-lg { width: 44px; height: 44px; border-radius: 12px; }
.sc-avatar.is-blank { display: inline-block; border: 1.5px dashed var(--color-border-strong); background: transparent; }
.sc-kid { position: relative; }
.sc-kid-btn { display: flex; align-items: center; gap: .6rem; width: 100%; height: auto; min-height: 44px; padding: .35rem .7rem .35rem .4rem; text-align: left; cursor: pointer; }
.sc-kid-btn .sc-kid-name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-kid-btn > .sc-ico { color: var(--color-text-muted); }
.sc-pop { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 60; display: grid; gap: .5rem; padding: .6rem; border: 1px solid var(--color-border); border-radius: 14px; background: var(--color-bg-card); box-shadow: 0 18px 40px rgba(0,0,0,.18); }
.sc-options { list-style: none; margin: 0; padding: 0; max-height: 320px; overflow: auto; display: grid; gap: 1px; }
.sc-options li { display: flex; align-items: center; gap: .6rem; padding: .4rem .5rem; border-radius: 9px; cursor: pointer; }
.sc-options li.is-active { background: var(--color-bg-hover); }
.sc-options li[aria-selected="true"] { font-weight: 600; }
.sc-opt-main { display: grid; flex: 1; min-width: 0; }
.sc-opt-main > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-none { padding: .75rem; color: var(--color-text-muted); cursor: default !important; }

/* Photos */
.sc-photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 1.25rem; }
.sc-photos.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sc-photos.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.sc-photo { display: grid; gap: .65rem; align-content: start; min-width: 0; }
.sc-photo-frame { position: relative; display: block; width: 100%; padding: 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-bg-secondary); cursor: pointer; }
.sc-photo-frame img { display: block; width: 100%; height: 100%; object-fit: cover; }
.sc-photo-frame.is-whole { aspect-ratio: auto; }
.sc-photo-frame.is-whole img { height: auto; max-height: 340px; object-fit: contain; margin: 0 auto; }
.sc-photo-none { display: grid; place-items: center; gap: .3rem; min-height: 140px; height: 100%; color: var(--color-text-muted); font-size: var(--fs-xs); }
.sc-photo-tag { position: absolute; left: 8px; top: 8px; padding: .15rem .5rem; border-radius: 999px; background: rgba(20,21,24,.72); color: #fff; font-size: var(--fs-2xs); font-weight: 600; }
.sc-photo-change { position: absolute; right: 8px; bottom: 8px; padding: .3rem .7rem; border-radius: 999px; background: rgba(20,21,24,.78); color: #fff; font-size: var(--fs-2xs); font-weight: 600; opacity: 0; transition: opacity .15s; }
.sc-photo-frame:hover .sc-photo-change, .sc-photo-frame:focus-visible .sc-photo-change { opacity: 1; }
.sc-photo-frame:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.sc-photo-meta { display: grid; gap: .15rem; min-width: 0; }
.sc-photo-label { font-size: var(--fs-sm); }
.sc-photo-from { font-size: var(--fs-xs); color: var(--color-text-secondary); }
.sc-photo-actions { display: flex; gap: .35rem; flex-wrap: wrap; margin-top: .35rem; }
.sc-photo.is-compact .sc-photo-meta > .sc-hint { display: none; }
.sc-photo.is-compact .sc-photo-label { display: none; }
.sc-mini { margin: 0; display: grid; gap: .35rem; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.sc-mini img { width: 100%; aspect-ratio: 5 / 4; object-fit: cover; border-radius: 10px; border: 1px solid var(--color-border); }

/* Photo picker */
.sc-dialog.is-wide { width: min(1080px, calc(100vw - 2rem)); max-width: none; }
.sc-dialog.is-tall .sc-dialog-body { min-height: min(62vh, 640px); }
.sc-dialog { display: flex; flex-direction: column; max-height: calc(100vh - 2rem); }
.sc-dialog-head { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; margin-bottom: .75rem; }
.sc-dialog-head h3 { margin: 0; font-size: var(--fs-lg); }
.sc-dialog-body { overflow: auto; min-height: 0; flex: 1; }
.sc-dialog-foot { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.sc-overlay { z-index: 1200; }
.sc-tabs { display: flex; gap: .25rem; margin-bottom: 1rem; border-bottom: 1px solid var(--color-border); }
.sc-tabs button { position: relative; padding: .55rem .8rem; border: 0; background: none; color: var(--color-text-secondary); font: inherit; font-weight: 600; font-size: var(--fs-sm); cursor: pointer; }
.sc-tabs button.is-on { color: var(--color-text); }
.sc-tabs button.is-on::after { content: ''; position: absolute; left: .8rem; right: .8rem; bottom: -1px; height: 3px; border-radius: 3px 3px 0 0; background: var(--color-primary); }
.sc-pick-kids { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 1rem; }
.sc-pick-side { display: grid; gap: .5rem; align-content: start; }
.sc-pick-kidlist { list-style: none; margin: 0; padding: 0 .5rem 0 0; max-height: 52vh; overflow: auto; display: grid; gap: 1px; scrollbar-gutter: stable; }
.sc-pick-kidlist .sc-count { flex-shrink: 0; }
.sc-pick-kidlist button { display: flex; align-items: center; gap: .55rem; width: 100%; padding: .35rem .45rem; border: 0; border-radius: 9px; background: transparent; color: var(--color-text); font: inherit; font-size: var(--fs-sm); text-align: left; cursor: pointer; }
.sc-pick-kidlist button span:nth-child(2) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-pick-kidlist button:hover { background: var(--color-bg-hover); }
.sc-pick-kidlist button.is-on { background: var(--color-bg-secondary); font-weight: 600; box-shadow: inset 3px 0 0 var(--color-primary); }
.sc-pick-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: .5rem; align-content: start; }
.sc-tile { position: relative; padding: 0; aspect-ratio: 1; overflow: hidden; border: 2px solid transparent; border-radius: 10px; background: var(--color-bg-secondary); cursor: pointer; }
.sc-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sc-tile.is-sel { border-color: var(--color-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 35%, transparent); }
.sc-tile:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.sc-tile-check { position: absolute; top: 6px; right: 6px; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--color-primary); color: #1A1B1F; }
.sc-tile-now { position: absolute; left: 6px; bottom: 6px; padding: .05rem .45rem; border-radius: 999px; background: rgba(20,21,24,.75); color: #fff; font-size: var(--fs-2xs); font-weight: 600; }
.sc-pick-filters { display: grid; gap: .6rem; margin-bottom: .85rem; }
.sc-chips { display: flex; gap: .35rem; flex-wrap: wrap; }
.sc-chips button { display: inline-flex; align-items: center; gap: .3rem; padding: .3rem .7rem; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-bg-card); color: var(--color-text-secondary); font: inherit; font-size: var(--fs-xs); font-weight: 600; text-transform: capitalize; cursor: pointer; }
.sc-chips button.is-on { background: var(--color-text); border-color: var(--color-text); color: var(--color-bg-card); }
.sc-more { margin-top: .85rem; }
.sc-drop { display: grid; place-items: center; gap: .6rem; min-height: 300px; padding: 2rem; border: 2px dashed var(--color-border-strong); border-radius: 14px; text-align: center; color: var(--color-text-secondary); }
.sc-drop.is-over { border-color: var(--color-primary); background: var(--color-primary-bg); }
.sc-drop.is-small { min-height: 0; padding: 1.25rem; }
.sc-drop p { margin: 0; }
.sc-pick-preview { display: flex; align-items: center; gap: .75rem; margin-right: auto; min-width: 0; }
.sc-pick-crop { display: block; height: 72px; overflow: hidden; border-radius: 8px; border: 1px solid var(--color-border); background: var(--color-bg-secondary); }
.sc-pick-crop img { display: block; height: 100%; width: 100%; object-fit: cover; }

/* Hero preview */
.sc-hero-pv { position: relative; margin: 1.25rem 0 0; padding: 1.5rem 1.6rem 1.4rem; border: 1px solid var(--color-border); border-radius: 14px; background: var(--color-bg-secondary); }
.sc-pv-tag { display: inline-block; padding: .1rem .5rem; border-radius: 999px; background: color-mix(in srgb, var(--color-text) 8%, transparent); color: var(--color-text-secondary); font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.sc-hero-pv .sc-pv-tag { position: absolute; right: 12px; top: 12px; }
.sc-hero-pv-eyebrow { margin: 0 0 .6rem; font-size: .72rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--color-text-secondary); }
.sc-hero-pv-h { margin: 0 0 .7rem; font-family: 'Libre Baskerville', Georgia, serif; font-size: clamp(1.4rem, 2.6vw, 2rem); line-height: 1.1; letter-spacing: -.03em; color: var(--color-text); }
.sc-hero-pv-h em, .sc-hero-pv-lead em { font-style: italic; background-image: linear-gradient(transparent 52%, color-mix(in srgb, var(--color-primary) 45%, transparent) 52%); padding: 0 .05em; }
.sc-hero-pv-lead { margin: 0 0 1rem; max-width: 36rem; font-size: .92rem; line-height: 1.6; color: var(--color-text-secondary); }
.sc-hero-pv-btns { display: flex; gap: .5rem; flex-wrap: wrap; }
.sc-hero-pv-btns span { padding: .45rem 1rem; border-radius: 999px; font-size: .82rem; font-weight: 700; }
.sc-hero-pv-btns .is-yellow { background: var(--color-primary); color: #1A1B1F; }
.sc-hero-pv-btns .is-dark { background: var(--color-text); color: var(--color-bg-card); }

/* Financials */
.sc-num { display: flex; align-items: center; border: 1px solid var(--color-border); border-radius: var(--radius-sm, 8px); background: var(--color-bg-card); }
.sc-num:focus-within { border-color: var(--color-border-strong); box-shadow: var(--focus-ring-strong); }
.sc-num > span { padding-left: .75rem; color: var(--color-text-muted); font-weight: 600; }
.sc-num .form-input { border: 0; box-shadow: none !important; background: transparent; font-variant-numeric: tabular-nums; }
.sc-split-bar { display: flex; height: 14px; margin: .5rem 0 .55rem; overflow: hidden; border-radius: 999px; background: var(--color-bg-secondary); }
.sc-split-bar span { min-width: 0; transition: flex .25s; }
.is-prog { background: var(--color-primary); }
.is-mgmt { background: #2a78d6; }
.is-fund { background: #1baf7a; }
.sc-split-key { display: flex; gap: .4rem 1.1rem; flex-wrap: wrap; margin: 0; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.sc-split-key span { display: inline-flex; align-items: center; gap: .35rem; }
.sc-split-key i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.sc-pv-line { display: grid; gap: .4rem; margin-top: 1.25rem; padding: .85rem 1rem; border-radius: 12px; background: var(--color-bg-secondary); font-size: .86rem; color: var(--color-text-secondary); }
.sc-pv-line > span { display: flex; gap: .55rem; align-items: baseline; flex-wrap: wrap; }
.sc-docs + .sc-docs { margin-top: .5rem; }
.sc-docs-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.sc-docs-head .sc-h4 { margin: .9rem 0 .5rem; }
.sc-doclist { list-style: none; margin: 0 0 .5rem; padding: 0; display: grid; }
.sc-doclist li { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr) auto; gap: .75rem; align-items: center; padding: .45rem 0; border-top: 1px solid var(--color-border); }
.sc-doclist li:first-child { border-top: 0; }
.sc-doclist li.sc-empty { display: block; }
.sc-year { font-variant-numeric: tabular-nums; font-weight: 600; }
.sc-doc-name { display: inline-flex; align-items: center; gap: .35rem; min-width: 0; font-size: var(--fs-xs); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-row-actions { display: inline-flex; gap: .3rem; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.sc-row-actions .btn { display: inline-flex; align-items: center; gap: .3rem; }
.sc-reports { list-style: none; margin: 0; padding: 0; display: grid; gap: .85rem; }
.sc-reports li { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 1rem; padding: .85rem; border: 1px solid var(--color-border); border-radius: 12px; }
.sc-reports .sc-photo-actions { margin: 0; }

/* FAQ */
.sc-faq { display: flex; align-items: flex-start; gap: .75rem; width: 100%; padding: .2rem 0; border: 0; background: none; color: var(--color-text); font: inherit; text-align: left; cursor: pointer; }
.sc-faq-n { padding-top: .1rem; font-size: var(--fs-2xs); font-weight: 700; color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.sc-faq-text { display: grid; gap: .15rem; flex: 1; min-width: 0; }
.sc-faq-text strong { font-size: var(--fs-sm); }
.sc-faq-text .sc-hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-faq:hover strong { text-decoration: underline; text-underline-offset: 3px; }
.sc-faq-edit { display: grid; gap: .1rem; }
.sc-faq-foot { display: flex; justify-content: space-between; align-items: center; gap: .75rem; flex-wrap: wrap; }

/* Social, badges, history */
.sc-social { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; align-items: center; }
.sc-badge { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 1rem; align-items: start; }
.sc-badge-art { display: grid; gap: .45rem; justify-items: center; }
.sc-badge-tile { display: grid; place-items: center; width: 96px; height: 96px; border-radius: 12px; background: #1E1F25; color: rgba(255,255,255,.7); font-size: var(--fs-2xs); text-align: center; padding: .5rem; }
.sc-badge-tile img { width: 72px; height: 72px; object-fit: contain; }
.sc-hist { list-style: none; margin: 0; padding: 0; display: grid; }
.sc-hist li { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .7rem 0; border-top: 1px solid var(--color-border); }
.sc-hist li:first-child { border-top: 0; }
.sc-hist li > div { display: grid; gap: .1rem; min-width: 0; }
.sc-diff { list-style: none; margin: 0; padding: 0; display: grid; gap: .6rem; }
.sc-diff li { display: grid; gap: .3rem; padding: .75rem .85rem; border: 1px solid var(--color-border); border-radius: 10px; font-size: var(--fs-sm); }
.sc-diff-then { color: var(--color-text-secondary); }
.sc-diff-now { color: var(--color-text-muted); }

/* Phones and narrow windows: the page list, then a page */
@media (max-width: 1180px) { .sc-split, .sc-split.is-photo-first { grid-template-columns: minmax(0, 1fr); } .sc-photos.cols-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 900px) {
  .sc-area { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .sc-area.has-page .sc-rail { display: none; }
  .sc-area.is-list .sc-main { display: none; }
  .sc-rail { position: static; max-height: none; overflow: visible; padding: 0; }
  .sc-rail-list a { padding: .8rem .75rem; min-height: 52px; }
  .sc-rail-sub { white-space: normal; }
  .sc-back { display: inline-flex; width: 44px; height: 44px; margin-left: -.5rem; }
  .sc-hide-sm { display: none !important; }
  .sc-card { padding: 1.1rem 1rem 1.2rem; }
  .sc-mile, .sc-badge, .sc-reports li { grid-template-columns: minmax(0, 1fr); }
  .sc-pick-kids { grid-template-columns: minmax(0, 1fr); }
  .sc-pick-kidlist { max-height: 30vh; }
}
@media (max-width: 640px) {
  .sc-pair, .sc-trio, .sc-photos.cols-2, .sc-photos.cols-3, .sc-catrow { grid-template-columns: minmax(0, 1fr); }
  .sc-pair.is-narrow-first { grid-template-columns: 6rem minmax(0, 1fr); }
  .sc-bar { flex-wrap: wrap; padding: .55rem .65rem; }
  .sc-bar-actions { width: 100%; }
  .sc-bar-actions .btn-primary { margin-left: auto; }
  .sc-hide-xs { display: none; }
  .sc-root .form-input, .sc-root select, .sc-root textarea, .sc-root input:not([type="checkbox"]):not([type="radio"]), .sc-rich-text { font-size: 16px; }
  .sc-icon-btn { width: 44px; height: 44px; }
  .sc-grip { width: 32px; height: 44px; }
  .sc-row { grid-template-columns: auto minmax(0, 1fr); }
  .sc-row-tools { grid-column: 1 / -1; justify-content: flex-end; border-top: 1px solid var(--color-border); padding-top: .35rem; }
  .sc-doclist li { grid-template-columns: 5rem minmax(0, 1fr); }
  .sc-doclist .sc-row-actions { grid-column: 1 / -1; justify-content: flex-start; }
  .sc-seg { display: flex; }
  .sc-seg button { flex: 1 1 auto; min-height: 44px; }
  .sc-tool { min-width: 36px; height: 36px; }
  .sc-pop { position: fixed; left: .5rem; right: .5rem; top: auto; bottom: calc(.5rem + env(safe-area-inset-bottom, 0px)); max-height: 70vh; }
  .sc-options { max-height: 50vh; }
  .sc-dialog.is-wide { width: 100vw; }
}
`;
let styled = false;
function injectStyles() {
  if (styled) return;
  styled = true;
  let s = document.getElementById('sc-style');
  if (!s) { s = document.createElement('style'); s.id = 'sc-style'; document.head.append(s); }
  s.textContent = CSS;
}
