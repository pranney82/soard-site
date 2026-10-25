/**
 * Admin → the file viewer (used by ./applicants.js and ./applications.js)
 * ===========================================================================
 * A family's photos, PDFs and videos open over the page they're on instead
 * of in a new tab: one dark, full-screen viewer, the way Drive, Slack and
 * Photos show a file.
 *
 *  - Photos fit the screen. Double-click (or double-tap) zooms in where you
 *    pointed, ⌘/Ctrl-scroll or a pinch zooms, drag looks around. A photo the
 *    browser can't open (HEIC in Chrome) shows its `preview` instead.
 *  - PDFs are drawn by pdf.js (./vendor-pdf.js, loaded the first time one
 *    opens), so they read the same on every computer and phone: text can be
 *    selected, links work, − / + or a pinch zooms.
 *  - Videos play with the browser's own controls. Nothing is drawn on the
 *    picture: the arrows sit beside it (under it on a phone).
 *  - Anything else (a Word file) says so and offers Download.
 *
 * The files passed in are one set: ← / →, the arrows, a swipe on a phone or
 * the strip of thumbnails steps through them. Esc, ✕ or Back closes it, and
 * focus goes back to whatever opened it. Download saves the file under its
 * own name; ↗ opens it in a new tab (to print it, say).
 *
 * Links stay links: viewerLink(files, i) gives an <a> its href and a click
 * handler, so ⌘/Ctrl-click or a middle click still opens a new tab.
 *
 * A file: { name, type, url, size?, at?, thumb?, preview?, filename? }.
 * `thumb` is a small JPEG (JobTread makes one for photos, PDFs and videos)
 * for the strip, shown while the full photo loads; `filename` is what
 * Download saves it as when `name` is a label ("Photo of the bedroom").
 */

import { h, htm, render, useState, useEffect, useRef, useCallback } from './vendor.js';

const html = htm.bind(h);

// ─── What a file is ─────────────────────────────────────────────────

export function kindOf(f) {
  const t = String(f?.type || '').toLowerCase();
  const n = String(f?.name || '').toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (t.startsWith('image/') || /\.(jpe?g|png|gif|webp|avif|heic|heif)$/.test(n)) return 'image';
  if (t.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/.test(n)) return 'video';
  if (t.startsWith('audio/') || /\.(mp3|m4a|wav|aac|ogg)$/.test(n)) return 'audio';
  return 'other';
}
const KIND = { image: 'Photo', pdf: 'PDF', video: 'Video', audio: 'Audio', other: 'File' };
const EMOJI = { image: '🖼', pdf: '📄', video: '🎬', audio: '🎧', other: '📎' };
export const kindIcon = (f) => EMOJI[kindOf(f)];
/** ".jpg" for image/jpeg and the like, for a file saved under a label */
export const extOf = (type) => ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf', 'video/mp4': '.mp4', 'video/quicktime': '.mov' }[String(type || '').toLowerCase()] || '');
export const sizeText = (b) => (!b ? '' : b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const dayText = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ─── Opening it ─────────────────────────────────────────────────────

let host = null;
let backPending = null; // the history.back() a close started, until its popstate lands

/** Show files[index], with the rest of `files` a step away */
export function openViewer(files, index = 0) {
  const list = (files || []).filter((f) => f?.url);
  if (!list.length) return;
  const start = Math.max(0, list.indexOf(files[index]));
  injectCss();
  warmFiles(list);
  if (!host) {
    host = document.createElement('div');
    host.className = 'fv-host';
    document.body.appendChild(host);
  }
  render(html`<${Viewer} key=${Date.now()} files=${list} start=${start} onClosed=${() => render(null, host)} />`, host);
}

/** Load pdf.js (and start its worker) ahead of a PDF being opened, so the first one opens at once */
export function warmFiles(files) {
  if ((files || []).some((f) => f && kindOf(f) === 'pdf')) loadPdf().then((m) => { pdfWorker ||= new m.pdfjsLib.PDFWorker(); }).catch(() => {});
}

/** Props for an <a> that opens the viewer on a plain click and a new tab on ⌘/Ctrl/middle click */
export function viewerLink(files, i) {
  const warm = () => warmFiles([files[i]]);
  return {
    href: files[i]?.url,
    target: '_blank',
    rel: 'noopener',
    onPointerEnter: warm,
    onFocus: warm,
    onClick: (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openViewer(files, i);
    },
  };
}

// The admin's own way to a JobTread file (functions/api/applicants-admin.js ?cdn=), for when the browser can't
// fetch from JobTread's CDN itself: a tab opened before the admin's CSP allowed the CDN, or a network that blocks it
const onJobTread = (url) => /^https:\/\/cdn\.jobtread\.com\//.test(url);
const viaSite = (url) => new URL(`/api/applicants-admin?cdn=${encodeURIComponent(url)}`, location.href).href;

/** Save a file under its own name. JobTread's files are on another site, where <a download> is ignored */
async function saveFile(f, onProgress) {
  const a = document.createElement('a');
  a.download = f.filename || f.name || '';
  a.rel = 'noopener';
  let blobUrl = null;
  if (new URL(f.url, location.href).origin === location.origin) a.href = f.url;
  else {
    const direct = new URL(f.url, location.href).href;
    let r = await fetch(direct, { credentials: 'omit' }).catch((e) => (onJobTread(direct) ? null : Promise.reject(e)));
    if (!r?.ok && onJobTread(direct)) r = await fetch(viaSite(direct));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // Read it in pieces so a big file (families send videos and scans of 100 MB) shows how far along it is
    const total = Number(r.headers.get('content-length')) || f.size || 0;
    let blob;
    if (r.body && total) {
      const parts = [];
      let got = 0;
      for (const reader = r.body.getReader(); ;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.byteLength;
        onProgress?.(got / total);
      }
      blob = new Blob(parts, { type: r.headers.get('content-type') || '' });
    } else blob = await r.blob();
    blobUrl = URL.createObjectURL(blob);
    a.href = blobUrl;
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

// ─── The viewer ─────────────────────────────────────────────────────

const FOCUSABLE = 'button:not([disabled]), a[href], video[controls], audio[controls], [tabindex]:not([tabindex="-1"])';

function Viewer({ files, start, onClosed }) {
  const [i, setI] = useState(start);
  // What the open photo or PDF reports, each stamped with its file: a photo already left (its <img>
  // still firing) can't put its zoom or "Shown as a preview" on the file after it
  const [zoomOf, setZoom] = useState(null); // { url, pct, canIn, canOut }
  const [pageOf, setPage] = useState(null); // PDFs: { url, n, of }
  const [noteOf, setNote] = useState(null); // { url, text }, e.g. "Shown as a preview"
  const [saving, setSaving] = useState(false); // false, or how far a download has got (0 to 1)
  const [saveErr, setSaveErr] = useState(false);
  const root = useRef(null);
  const strip = useRef(null);
  const ctl = useRef(null); // the open photo's or PDF's zoom: { zoomIn, zoomOut, fit }
  const player = useRef(null); // the open video's: { toggle, mute, full }
  const token = useRef(Math.random().toString(36).slice(2));
  const closing = useRef(false);
  const n = files.length;
  const f = files[i];
  const kind = kindOf(f);
  const mine = (x) => (x && x.url === f.url ? x : null);
  const zoom = mine(zoomOf);
  const page = mine(pageOf);
  const note = mine(noteOf)?.text;
  const stamp = (set) => (v) => set(v ? { ...(typeof v === 'string' ? { text: v } : v), url: f.url } : null);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (history.state?.fileViewer === token.current) {
      // Done when the browser has stepped back (or after a second, so a lost popstate can't hold the next viewer up)
      backPending = new Promise((resolve) => {
        const done = () => { window.removeEventListener('popstate', done); backPending = null; resolve(); };
        window.addEventListener('popstate', done);
        setTimeout(done, 1000);
      });
      history.back();
    }
    onClosed();
  }, [onClosed]);
  // Another file: what the last one reported (zoom, page, notes) goes with it
  const show = (j) => {
    const next = clamp(j, 0, n - 1);
    if (next === i) return;
    setZoom(null);
    setPage(null);
    setNote(null);
    setSaveErr(false);
    setI(next);
  };
  const go = (d) => show(i + d);
  const goRef = useRef(go);
  goRef.current = go;
  const onStep = useCallback((d) => goRef.current(d), []);

  // Focus and keys are the viewer's from the moment it's on screen (an effect waits for the next
  // paint, and an Esc pressed before then would close the drawer underneath), like the drawer's own
  const before = useRef(null);
  const attach = useCallback((el) => {
    if (el) {
      root.current = el;
      before.current = document.activeElement;
      el.focus({ preventScroll: true });
      const inside = (e) => keyRef.current(e);
      // A key pressed while focus is somewhere else (it shouldn't be) is still the viewer's, never the drawer's
      const outside = (e) => { if (!el.contains(e.target)) keyRef.current(e); };
      el.addEventListener('keydown', inside);
      window.addEventListener('keydown', outside, true);
      el._detach = () => { el.removeEventListener('keydown', inside); window.removeEventListener('keydown', outside, true); };
    } else if (root.current) {
      root.current._detach?.();
    }
  }, []);

  // Open: the page under it stops scrolling, and Back closes it (the address stays the same)
  useEffect(() => {
    document.body.classList.add('fv-open');
    let live = true;
    const onPop = () => { if (live && !closing.current) { closing.current = true; onClosed(); } };
    (async () => {
      if (backPending) await backPending;
      if (!live) return;
      history.pushState({ ...(history.state || {}), fileViewer: token.current }, '', location.href);
      window.addEventListener('popstate', onPop);
    })();
    return () => {
      live = false;
      window.removeEventListener('popstate', onPop);
      document.body.classList.remove('fv-open');
      if (before.current?.isConnected) before.current.focus?.({ preventScroll: true });
    };
  }, []);

  // Focus stays inside: when the focused control goes away (the zoom buttons, between files), the viewer takes it
  useEffect(() => {
    if (root.current && !root.current.contains(document.activeElement)) root.current.focus({ preventScroll: true });
  });

  // The photos either side load ahead; the strip keeps the open file in view
  useEffect(() => {
    for (const j of [i + 1, i - 1]) if (files[j] && kindOf(files[j]) === 'image') new Image().src = files[j].url;
    strip.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [i]);

  const download = async () => {
    setSaving(0);
    setSaveErr(false);
    let shown = 0;
    try { await saveFile(f, (p) => { const pct = Math.floor(p * 100); if (pct !== shown) { shown = pct; setSaving(p); } }); } catch { setSaveErr(true); }
    setSaving(false);
  };

  const onKey = (e) => {
    // The drawer and the page under the viewer don't see these keys (Esc would close the family too)
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      const els = [...root.current.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length);
      if (!els.length) { e.preventDefault(); return; }
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || /^(VIDEO|AUDIO|INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    // A video: Space (unless a button has focus) or K plays and pauses, M mutes, F goes full screen
    const p = player.current;
    if (p && ((e.key === ' ' && e.target === root.current) || e.key === 'k')) { e.preventDefault(); p.toggle(); return; }
    if (p && e.key === 'm') { e.preventDefault(); p.mute(); return; }
    if (p && e.key === 'f') { e.preventDefault(); p.full(); return; }
    if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight' && i < n - 1) { e.preventDefault(); go(1); }
    else if ((e.key === '+' || e.key === '=') && ctl.current) { e.preventDefault(); ctl.current.zoomIn(); }
    else if ((e.key === '-' || e.key === '_') && ctl.current) { e.preventDefault(); ctl.current.zoomOut(); }
    else if (e.key === '0' && ctl.current) { e.preventDefault(); ctl.current.fit(); }
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;

  const meta = [KIND[kind], sizeText(f.size), dayText(f.at)].filter(Boolean).join(' · ');
  const prev = () => html`<button class="fv-btn fv-nav" onClick=${() => go(-1)} disabled=${i === 0} aria-label="Previous file (←)" title="Previous (←)">${I.left()}</button>`;
  const next = () => html`<button class="fv-btn fv-nav" onClick=${() => go(1)} disabled=${i === n - 1} aria-label="Next file (→)" title="Next (→)">${I.right()}</button>`;
  const fail = (msg) => html`<${Card} f=${f} title=${msg.title} text=${msg.text} onSave=${download} saving=${saving !== false} />`;
  let media;
  if (kind === 'image') media = html`<${ImageView} key=${f.url} f=${f} ctl=${ctl} onZoom=${stamp(setZoom)} onNote=${stamp(setNote)} onStep=${onStep} fail=${fail} />`;
  else if (kind === 'pdf') media = html`<${PdfView} key=${f.url} f=${f} ctl=${ctl} onZoom=${stamp(setZoom)} onPage=${stamp(setPage)} fail=${fail} />`;
  else if (kind === 'video') media = html`<${VideoView} key=${f.url} f=${f} player=${player} fail=${fail} />`;
  else if (kind === 'audio') media = html`<div class="fv-audio"><span aria-hidden="true">${EMOJI.audio}</span><audio key=${f.url} src=${f.url} controls autoplay preload="metadata"></audio></div>`;
  else media = fail({ title: 'This file can’t be shown here', text: 'Download it to open it on your computer.' });

  return html`<div class="fv" role="dialog" aria-modal="true" aria-label=${n > 1 ? `${f.name} (${i + 1} of ${n})` : f.name} tabindex="-1" ref=${attach}>
    <header class="fv-bar">
      <div class="fv-title">
        <span class="fv-title-kind" aria-hidden="true">${EMOJI[kind]}</span>
        <div><strong title=${f.name}>${f.name || 'File'}</strong><small>${meta}</small></div>
      </div>
      ${n > 1 && html`<span class="fv-count" aria-hidden="true">${i + 1} of ${n}</span>`}
      <div class="fv-actions">
        <button class="fv-btn" onClick=${download} disabled=${saving !== false} aria-label=${saving !== false ? 'Downloading' : 'Download'} title=${saveErr ? 'Couldn’t download it. Try Open in a new tab.' : 'Download'}>${saving !== false ? I.wait() : I.down()}</button>
        <a class="fv-btn" href=${f.url} target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab">${I.ext()}</a>
        <button class="fv-btn" onClick=${close} aria-label="Close (Esc)" title="Close (Esc)">${I.close()}</button>
      </div>
    </header>
    <div class="fv-stage">
      ${n > 1 && html`<div class="fv-side">${prev()}</div>`}
      <div class=${`fv-media is-${kind}`}>${media}</div>
      ${n > 1 && html`<div class="fv-side">${next()}</div>`}
    </div>
    <footer class="fv-foot">
      <div class="fv-foot-start">
        ${n > 1 && html`<div class="fv-pnav">${prev()}<span class="fv-count">${i + 1} of ${n}</span>${next()}</div>`}
        ${page && html`<span class="fv-page">Page ${page.n} of ${page.of}</span>`}
        ${note && html`<span class="fv-note">${note}</span>`}
        ${saving !== false && (f.size || 0) > 4 * 1048576 && html`<span class="fv-note" aria-live="polite">Downloading… ${Math.floor(saving * 100)}%</span>`}
        ${saveErr && html`<span class="fv-note" role="alert">Couldn’t download it. Open it in a new tab and save it from there.</span>`}
      </div>
      ${n > 1 && html`<div class="fv-strip" ref=${strip} role="group" aria-label="Files">
        ${files.map((x, j) => html`<${Thumb} f=${x} current=${j === i} onClick=${() => show(j)} />`)}
      </div>`}
      <div class="fv-tools">
        ${zoom && html`
          <button class="fv-btn" onClick=${() => ctl.current?.zoomOut()} disabled=${!zoom.canOut} aria-label="Zoom out (−)" title="Zoom out (−)">${I.minus()}</button>
          <button class="fv-btn fv-pct" onClick=${() => ctl.current?.fit()} aria-label=${`${zoom.pct}%. Fit to the screen (0)`} title="Fit to the screen (0)">${zoom.pct}%</button>
          <button class="fv-btn" onClick=${() => ctl.current?.zoomIn()} disabled=${!zoom.canIn} aria-label="Zoom in (+)" title="Zoom in (+)">${I.plus()}</button>`}
      </div>
    </footer>
    <div class="fv-sr" aria-live="polite">${n > 1 ? `${i + 1} of ${n}: ${f.name}` : ''}</div>
  </div>`;
}

function Thumb({ f, current, onClick }) {
  const kind = kindOf(f);
  const [broken, setBroken] = useState(false);
  // JobTread's 256px thumbnail is plenty for a 54px tile; the strip is short, so every tile loads at once
  const src = f.thumb ? f.thumb.replace(/([?&]size=)\d+/, '$1256') : kind === 'image' ? f.url : null;
  return html`<button class="fv-thumb" aria-current=${current ? 'true' : 'false'} onClick=${onClick} aria-label=${f.name} title=${f.name}>
    ${src && !broken ? html`<img src=${src} alt="" decoding="async" onError=${() => setBroken(true)} />` : html`<span class="fv-thumb-icon" aria-hidden="true">${EMOJI[kind]}</span>`}
    ${kind !== 'image' && html`<span class="fv-thumb-kind" aria-hidden="true">${kind === 'video' ? '▶' : KIND[kind]}</span>`}
  </button>`;
}

/** A file that can't be shown (or didn't load): what happened, and Download */
function Card({ f, title, text, onSave, saving }) {
  return html`<div class="fv-card">
    <span class="fv-card-icon" aria-hidden="true">${EMOJI[kindOf(f)]}</span>
    <strong>${title}</strong>
    <p>${text}</p>
    <div class="fv-card-actions">
      <button class="fv-pill" onClick=${onSave} disabled=${saving}>${saving ? 'Downloading…' : 'Download'}</button>
      <a class="fv-pill is-quiet" href=${f.url} target="_blank" rel="noopener">Open in a new tab</a>
    </div>
  </div>`;
}

// ─── Photos ─────────────────────────────────────────────────────────

function ImageView({ f, ctl, onZoom, onNote, onStep, fail }) {
  const box = useRef(null);
  const img = useRef(null);
  const [src, setSrc] = useState(f.url);
  const [loaded, setLoaded] = useState(false);
  const [previewIn, setPreviewIn] = useState(false); // JobTread's screen-size copy, shown while a big original loads
  const [failed, setFailed] = useState(false);
  const t = useRef({ s: 1, x: 0, y: 0 }); // scale (1 = fits the screen) and pan, in CSS pixels
  const live = useRef(true); // a detached <img> still fires load and error: a photo already left says nothing
  useEffect(() => () => { live.current = false; }, []);

  const maxScale = () => {
    const el = img.current;
    return el?.offsetWidth ? Math.max(4, (el.naturalWidth / el.offsetWidth) * 2) : 4;
  };
  const apply = () => {
    const el = img.current;
    if (!el) return;
    const { s, x, y } = t.current;
    el.style.transform = s === 1 ? '' : `translate(${x}px, ${y}px) scale(${s})`;
    box.current?.classList.toggle('is-zoomed', s > 1);
    if (el.naturalWidth && el.offsetWidth) onZoom({ pct: Math.round((s * el.offsetWidth / el.naturalWidth) * 100), canIn: s < maxScale() - 0.01, canOut: s > 1 });
  };
  const set = (s, x, y) => {
    const el = img.current;
    const r = box.current?.getBoundingClientRect();
    if (!el || !r) return;
    s = clamp(s, 1, maxScale());
    const mx = Math.max(0, (el.offsetWidth * s - r.width) / 2);
    const my = Math.max(0, (el.offsetHeight * s - r.height) / 2);
    t.current = s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: clamp(x, -mx, mx), y: clamp(y, -my, my) };
    apply();
  };
  // Zoom to scale s, keeping the point under (cx, cy) where it is (the middle when there's no point)
  const zoomTo = (s, cx, cy) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const ox = cx == null ? 0 : cx - (r.left + r.width / 2);
    const oy = cy == null ? 0 : cy - (r.top + r.height / 2);
    const cur = t.current;
    const ns = clamp(s, 1, maxScale());
    set(ns, ox - (ox - cur.x) * (ns / cur.s), oy - (oy - cur.y) * (ns / cur.s));
  };
  // A double-click goes to the photo's real size (at least twice the fitted size); again, back to fit
  const toggle = (cx, cy) => {
    const el = img.current;
    if (t.current.s > 1) set(1, 0, 0);
    else if (el?.offsetWidth) zoomTo(clamp(el.naturalWidth / el.offsetWidth, 2, maxScale()), cx, cy);
  };

  useEffect(() => {
    ctl.current = { zoomIn: () => zoomTo(t.current.s * 1.5), zoomOut: () => zoomTo(t.current.s / 1.5), fit: () => set(1, 0, 0) };
    const el = box.current;
    const pts = new Map();
    let g = null; // the gesture under way: pan, pinch or swipe
    let lastTap = { at: 0, x: 0, y: 0 };
    const down = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { el.setPointerCapture?.(e.pointerId); } catch { /* Safari: a pointer it no longer tracks */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, at: Date.now() });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        g = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: t.current.s };
      } else if (pts.size === 1) {
        g = t.current.s > 1 ? { type: 'pan', x: t.current.x, y: t.current.y } : { type: 'swipe' };
        if (t.current.s > 1) el.classList.add('is-panning');
      }
    };
    const move = (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (g?.type === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        zoomTo(g.s * (Math.hypot(a.x - b.x, a.y - b.y) / g.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
      } else if (g?.type === 'pan') {
        set(t.current.s, g.x + (p.x - p.x0), g.y + (p.y - p.y0));
      } else if (g?.type === 'swipe' && e.pointerType !== 'mouse' && img.current) {
        img.current.style.transform = `translateX(${p.x - p.x0}px)`;
      }
    };
    const up = (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      pts.delete(e.pointerId);
      el.classList.remove('is-panning');
      const dx = p.x - p.x0;
      const dy = p.y - p.y0;
      if (g?.type === 'swipe') {
        if (img.current && t.current.s === 1) img.current.style.transform = '';
        if (e.pointerType !== 'mouse' && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) { onStep(dx < 0 ? 1 : -1); g = null; return; }
      }
      // A tap: two in a row (close together, under 300ms apart) zoom in or back out
      if (g?.type !== 'pinch' && Math.abs(dx) < 8 && Math.abs(dy) < 8 && Date.now() - p.at < 300) {
        const now = Date.now();
        if (now - lastTap.at < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) { toggle(p.x, p.y); lastTap = { at: 0, x: 0, y: 0 }; }
        else lastTap = { at: now, x: p.x, y: p.y };
      }
      if (pts.size === 1 && t.current.s > 1) {
        const [q] = [...pts.values()];
        q.x0 = q.x;
        q.y0 = q.y;
        g = { type: 'pan', x: t.current.x, y: t.current.y };
      } else if (!pts.size) g = null;
    };
    // ⌘/Ctrl-scroll (and a trackpad pinch, which arrives as one) zooms; plain scrolling moves a zoomed photo
    const wheel = (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomTo(t.current.s * Math.exp(-clamp(e.deltaY, -50, 50) * 0.01), e.clientX, e.clientY);
      else if (t.current.s > 1) set(t.current.s, t.current.x - e.deltaX, t.current.y - e.deltaY);
    };
    const resize = () => set(t.current.s, t.current.x, t.current.y);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('resize', resize);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      window.removeEventListener('resize', resize);
      ctl.current = null;
    };
  }, []);

  const onError = () => {
    if (!live.current) return;
    // The browser can't open this kind of photo (HEIC in Chrome): show the preview JobTread (or the form) made of it
    const fallback = f.preview || f.thumb;
    if (src !== fallback && fallback) { setSrc(fallback); onNote('Shown as a preview. Download keeps the original photo.'); }
    else { onNote(''); setFailed(true); }
  };
  if (failed) return fail({ title: 'This photo didn’t load', text: 'It may have moved in JobTread. Download it, or open it in a new tab.' });
  return html`<div class="fv-imgbox" ref=${box}>
    ${!loaded && (f.thumb || f.preview ? html`<span class="fv-img-wait" aria-hidden="true">
      ${f.thumb && html`<img src=${f.thumb} alt="" />`}
      ${f.preview && f.preview !== src && html`<img src=${f.preview} alt="" class=${previewIn ? 'is-in' : ''} onLoad=${() => setPreviewIn(true)} />`}
    </span>` : html`<span class="fv-wait">Loading the photo…</span>`)}
    <img class=${`fv-img${loaded ? '' : ' is-loading'}`} ref=${img} src=${src} alt=${f.name || 'Photo'} draggable="false" decoding="async"
      onLoad=${() => { if (live.current) { setLoaded(true); requestAnimationFrame(apply); } }} onError=${onError} />
  </div>`;
}

// ─── PDFs ───────────────────────────────────────────────────────────

let pdfModule = null;
let pdfWorker = null;
const loadPdf = () => (pdfModule ||= import('./vendor-pdf.js').then((m) => {
  const el = document.createElement('style');
  el.id = 'fv-pdfjs-style';
  el.textContent = m.pdfCss;
  document.head.prepend(el); // first, so the viewer's own rules below win
  return m;
}).catch((e) => { pdfModule = null; throw e; }));

function PdfView({ f, ctl, onZoom, onPage, fail }) {
  const wrap = useRef(null);
  const [state, setState] = useState('loading'); // loading | ready | failed | locked
  const [got, setGot] = useState(null); // how much of a big PDF has arrived: { loaded, total? }
  const [whole, setWhole] = useState(false); // reading it in parts failed: read the whole file instead
  const [site, setSite] = useState(false); // the CDN can't be reached from this page: through the admin instead
  // JobTread's picture of page 1, shown while the PDF opens
  const peek = f.thumb ? f.thumb.replace(/([?&]size=)\d+/, '$12048') : null;
  useEffect(() => {
    let dead = false;
    let task = null;
    let viewer = null;
    let doc = null;
    let locked = false; // asked for a password: never fall back from that
    let range = null;
    const ac = new AbortController();
    const direct = new URL(f.url, location.href).href;
    const url = site ? viaSite(direct) : direct;
    // When JobTread's CDN can't be reached from this page, the admin passes the file through; past that,
    // a file read in parts is read whole, and only then does it fail
    const fallBack = () => {
      if (dead) return;
      if (!site && onJobTread(direct)) setSite(true);
      else if (range && !whole) setWhole(true);
      else setState('failed');
    };
    (async () => {
      try {
        const { pdfjsLib, PDFViewer, EventBus, PDFLinkService } = await loadPdf();
        if (dead) return;
        const container = wrap.current;
        const eventBus = new EventBus();
        const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2, externalLinkRel: 'noopener noreferrer nofollow' }); // 2: a new tab
        viewer = new PDFViewer({
          container, eventBus, linkService, abortSignal: ac.signal,
          removePageBorders: true,
          annotationMode: pdfjsLib.AnnotationMode.ENABLE, // form fields drawn as filled in, never editable
          annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
        });
        linkService.setViewer(viewer);
        eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'auto'; });
        eventBus.on('pagerendered', () => setState('ready')); // page 1 drawn: the picture of it gives way
        eventBus.on('pagechanging', (e) => onPage({ n: e.pageNumber, of: viewer.pagesCount }));
        eventBus.on('scalechanging', (e) => onZoom({ pct: Math.round(e.scale * 100), canIn: e.scale < 4, canOut: e.scale > 0.3 }));
        const base = new URL('./pdf/', import.meta.url).href;
        pdfWorker ||= new pdfjsLib.PDFWorker();
        // A big PDF on JobTread's CDN (scans run to 100 MB) is read in parts, only what the pages on screen
        // need, so page 1 shows in seconds, not after the whole file. The CDN takes a Range request with no
        // preflight but doesn't expose Accept-Ranges, so pdf.js can't find that out for itself.
        if (!whole && (f.size || 0) > 4 * 1048576 && (site || new URL(url).origin !== location.origin)) {
          let read = 0;
          range = new pdfjsLib.PDFDataRangeTransport(f.size, null);
          range.requestDataRange = (begin, end) => {
            fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, credentials: site ? 'same-origin' : 'omit', signal: ac.signal })
              .then((r) => (r.status === 206 ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
              .then((buf) => {
                read += buf.byteLength;
                if (!dead && read > 2 * 1048576) setGot({ loaded: read, total: null });
                range.onDataRange(begin, new Uint8Array(buf));
              })
              .catch(fallBack);
          };
        }
        task = pdfjsLib.getDocument({
          ...(range ? { range, rangeChunkSize: 1048576, disableAutoFetch: true } : { url, disableRange: true }),
          worker: pdfWorker,
          standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, useWasm: false, enableXfa: false,
        });
        task.onPassword = () => { locked = true; if (!dead) setState('locked'); task.destroy(); };
        let pct = -1;
        // (read in parts, the count is what's been read; pdf.js's own would read as if all of it were coming)
        if (!range) task.onProgress = ({ loaded, total }) => {
          const all = total || f.size || 0;
          const now = all ? Math.floor((loaded / all) * 100) : -1;
          if (!dead && all > 2 * 1048576 && now !== pct) { pct = now; setGot({ loaded, total: all }); }
        };
        doc = await task.promise;
        if (dead) return;
        viewer.setDocument(doc);
        linkService.setDocument(doc, null);
        onPage({ n: 1, of: doc.numPages });
        ctl.current = {
          zoomIn: () => viewer.increaseScale(),
          zoomOut: () => viewer.decreaseScale(),
          fit: () => { viewer.currentScaleValue = 'auto'; },
        };
      } catch (e) {
        if (dead) return;
        if (locked || e?.name === 'PasswordException') setState('locked');
        else fallBack();
      }
    })();
    // ⌘/Ctrl-scroll (or a trackpad pinch) zooms around the pointer
    wrap.current.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !viewer?.pdfDocument) return;
      e.preventDefault();
      viewer.updateScale({ drawingDelay: 400, scaleFactor: Math.exp(-clamp(e.deltaY, -50, 50) * 0.01), origin: [e.clientX, e.clientY] });
    }, { passive: false, signal: ac.signal });
    return () => {
      dead = true;
      ctl.current = null;
      ac.abort();
      // pdf.js's page view asks for every page as it opens. Let those answers land in it before it's
      // cleared and the document goes (each one cut off is an error in the console), never past 10 seconds
      const end = () => { try { viewer?.setDocument(null); } catch { /* already gone */ } task?.destroy(); };
      if (!doc) end();
      else Promise.race([Promise.allSettled(Array.from({ length: doc.numPages }, (_, k) => doc.getPage(k + 1))), new Promise((r) => setTimeout(r, 10000))]).then(end);
    };
  }, [f.url, whole, site]);
  if (state === 'locked') return fail({ title: 'This PDF has a password', text: 'Download it and open it with the password.' });
  if (state === 'failed') return fail({ title: 'This PDF didn’t open', text: 'It may have moved in JobTread. Download it, or open it in a new tab.' });
  return html`<div class="fv-pdf" ref=${wrap} tabindex="0" aria-label=${`${f.name || 'PDF'}, pages`}>
    <div class="pdfViewer"></div>
    ${state === 'loading' && html`<div class="fv-pdf-wait">
      ${peek && html`<img src=${peek} alt="" aria-hidden="true" onError=${(e) => { e.currentTarget.hidden = true; }} />`}
      <span class="fv-wait" aria-live="polite">Opening the PDF…${got ? ` ${sizeText(got.loaded)}${got.total ? ` of ${sizeText(got.total)}` : ' read'}` : ''}</span>
    </div>`}
  </div>`;
}

// ─── Videos ─────────────────────────────────────────────────────────

const clock = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The picture, and under it the player's bar: play, time, position, sound, full screen. Nothing is
 * drawn on the picture (the browser's own control bar included); full screen takes the bar along.
 */
function VideoView({ f, player, fail }) {
  const wrap = useRef(null);
  const vid = useRef(null);
  const bar = useRef(null);
  const [failed, setFailed] = useState(false);
  const [st, setSt] = useState({ playing: false, t: 0, d: 0, muted: false, waiting: true });
  const sync = (waiting) => {
    const v = vid.current;
    if (v) setSt((o) => ({ playing: !v.paused && !v.ended, t: v.currentTime, d: Number.isFinite(v.duration) ? v.duration : 0, muted: v.muted, waiting: typeof waiting === 'boolean' ? waiting : o.waiting }));
  };
  // It plays as soon as the first frames are in. (autoplay waits until the browser thinks the whole
  // video can play through, which for a family's phone video on a slow line can be half a minute.)
  const started = useRef(false);
  const start = () => {
    sync(false);
    if (started.current) return;
    started.current = true;
    vid.current?.play().catch(() => {});
  };
  // The picture as big as fits with the bar under it, and the bar as wide as the picture
  const fit = () => {
    const v = vid.current;
    const w = wrap.current;
    if (!v?.videoWidth || !w) return;
    const r = w.getBoundingClientRect();
    const room = r.height - (bar.current?.offsetHeight || 0) - 8;
    const s = Math.min(r.width / v.videoWidth, room / v.videoHeight);
    v.style.width = `${Math.floor(v.videoWidth * s)}px`;
    v.style.height = `${Math.floor(v.videoHeight * s)}px`;
    v.style.maxHeight = 'none';
    if (bar.current) bar.current.style.width = `${Math.min(r.width, Math.max(Math.floor(v.videoWidth * s), 300))}px`;
  };
  // A video recorded in a browser (MediaRecorder) doesn't say how long it is until it's been to the end
  const knowLength = (v) => {
    if (v.duration !== Infinity) return;
    v.addEventListener('timeupdate', function back() { v.removeEventListener('timeupdate', back); v.currentTime = 0; sync(); }, { once: true });
    v.currentTime = 1e101;
  };
  const toggle = () => { const v = vid.current; if (v) { if (v.paused || v.ended) v.play().catch(() => {}); else v.pause(); } };
  const mute = () => { const v = vid.current; if (v) v.muted = !v.muted; };
  const full = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (wrap.current?.requestFullscreen) wrap.current.requestFullscreen().catch(() => {});
    else vid.current?.webkitEnterFullscreen?.(); // iPhone: only the video itself goes full screen
  };
  useEffect(() => {
    player.current = { toggle, mute, full };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap.current);
    return () => { ro.disconnect(); player.current = null; if (document.fullscreenElement === wrap.current) document.exitFullscreen().catch(() => {}); };
  }, []);
  if (failed) return fail({ title: 'This video can’t play here', text: 'Download it to watch it on your computer.' });
  return html`<div class="fv-vid" ref=${wrap}>
    <video class="fv-video" ref=${vid} src=${f.url} poster=${f.thumb || undefined} playsinline preload="auto"
      onLoadedMetadata=${(e) => { fit(); sync(); knowLength(e.currentTarget); }} onCanPlay=${start} onWaiting=${() => sync(true)} onPlaying=${() => sync(false)}
      onDurationChange=${() => sync()} onTimeUpdate=${() => sync()} onPlay=${() => sync()} onPause=${() => sync()} onEnded=${() => sync()} onVolumeChange=${() => sync()}
      onClick=${toggle} onDblClick=${full} onError=${() => setFailed(true)}></video>
    <div class="fv-vbar" ref=${bar}>
      <button class="fv-btn" onClick=${toggle} aria-label=${st.playing ? 'Pause (K)' : 'Play (K)'} title=${st.playing ? 'Pause (K)' : 'Play (K)'}>${st.playing ? I.pause() : I.play()}</button>
      <span class="fv-time" aria-live="polite">${st.waiting ? 'Loading…' : `${clock(st.t)} / ${clock(st.d)}`}</span>
      <input class="fv-seek" type="range" min="0" max=${st.d || 0} step="0.1" value=${st.t} disabled=${!st.d}
        onInput=${(e) => { if (vid.current) vid.current.currentTime = Number(e.target.value); sync(); }}
        aria-label="Position in the video" aria-valuetext=${`${clock(st.t)} of ${clock(st.d)}`} />
      <button class="fv-btn" onClick=${mute} aria-label=${st.muted ? 'Turn the sound on (M)' : 'Mute (M)'} title=${st.muted ? 'Sound on (M)' : 'Mute (M)'}>${st.muted ? I.muted() : I.sound()}</button>
      <button class="fv-btn" onClick=${full} aria-label="Full screen (F)" title="Full screen (F)">${I.full()}</button>
    </div>
  </div>`;
}

// ─── Icons and styles ───────────────────────────────────────────────

const svg = (d, w = 20) => html`<svg width=${w} height=${w} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
const I = {
  close: () => svg(html`<path d="M5 5l10 10M15 5L5 15" />`),
  left: () => svg(html`<path d="M12.5 4.5L7 10l5.5 5.5" />`, 22),
  right: () => svg(html`<path d="M7.5 4.5L13 10l-5.5 5.5" />`, 22),
  down: () => svg(html`<path d="M10 3.5v9M6 9l4 4 4-4M4 16.5h12" />`),
  ext: () => svg(html`<path d="M11.5 3.5h5v5M16.5 3.5L9.5 10.5M14.5 11.5v5h-11v-11h5" />`),
  plus: () => svg(html`<path d="M10 4.5v11M4.5 10h11" />`),
  minus: () => svg(html`<path d="M4.5 10h11" />`),
  wait: () => svg(html`<path d="M10 3.5a6.5 6.5 0 1 1-6.5 6.5" class="fv-spin" />`),
  play: () => svg(html`<path d="M6.5 4.5v11l9-5.5z" fill="currentColor" />`),
  pause: () => svg(html`<path d="M7 4.5v11M13 4.5v11" stroke-width="2.6" />`),
  sound: () => svg(html`<path d="M3.5 8v4h3l4 3.5v-11l-4 3.5zM13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5a7 7 0 0 1 0 10" />`),
  muted: () => svg(html`<path d="M3.5 8v4h3l4 3.5v-11l-4 3.5zM13.5 8l4 4M17.5 8l-4 4" />`),
  full: () => svg(html`<path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" />`),
};

const CSS = `
.fv { position: fixed; inset: 0; z-index: 1400; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; background: #0E0F11; color: #F2F2F3; outline: none; animation: fv-in .16s ease-out; -webkit-font-smoothing: antialiased; }
@keyframes fv-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .fv { animation: none; } }
body.fv-open { overflow: hidden; }
body.fv-open .toast-container { z-index: 1450; }

.fv-bar { display: flex; align-items: center; gap: .75rem; min-height: 60px; padding: .5rem .6rem .5rem 1rem; padding-top: max(.5rem, env(safe-area-inset-top)); }
.fv-title { display: flex; align-items: center; gap: .7rem; flex: 1; min-width: 0; }
.fv-title-kind { font-size: 1.15rem; line-height: 1; }
.fv-title > div { min-width: 0; }
.fv-title strong { display: block; font-size: .95rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fv-title small { display: block; font-size: .78rem; color: #A8A9AF; margin-top: 1px; }
.fv-count { font-size: .85rem; color: #C8C9CD; font-variant-numeric: tabular-nums; white-space: nowrap; }
.fv-actions { display: flex; gap: .2rem; }
.fv-btn { width: 42px; height: 42px; flex: none; display: inline-grid; place-items: center; border: 0; border-radius: 10px; background: transparent; color: inherit; cursor: pointer; text-decoration: none; font: inherit; }
.fv-btn:focus-visible, .fv-thumb:focus-visible, .fv-pill:focus-visible, .fv-pdf:focus-visible { outline: 2px solid #FFDA24; outline-offset: 2px; }
.fv-btn[disabled] { opacity: .3; cursor: default; }
.fv-spin { transform-origin: 10px 10px; animation: fv-spin .8s linear infinite; }
@keyframes fv-spin { to { transform: rotate(360deg); } }

.fv-stage { display: grid; grid-template-columns: 72px minmax(0, 1fr) 72px; min-height: 0; }
.fv-stage > .fv-media:only-child { grid-column: 1 / -1; margin: 0 16px; }
.fv-side { display: grid; place-items: center; }
.fv-side .fv-nav { width: 48px; height: 48px; border-radius: 999px; background: rgba(255, 255, 255, .08); }
.fv-media { position: relative; min-width: 0; min-height: 0; display: grid; place-items: center; overflow: hidden; }

.fv-imgbox { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; touch-action: none; cursor: zoom-in; user-select: none; -webkit-user-select: none; }
.fv-imgbox.is-zoomed { cursor: grab; }
.fv-imgbox.is-panning { cursor: grabbing; }
.fv-img { display: block; width: auto; height: auto; max-width: 100%; max-height: 100%; border-radius: 0; transform-origin: center; -webkit-user-drag: none; }
.fv-imgbox:not(.is-zoomed) .fv-img { transition: transform .18s ease-out; }
.fv-img.is-loading { opacity: 0; }
.fv-img-wait { position: absolute; inset: 0; pointer-events: none; }
.fv-img-wait img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.fv-img-wait img + img:not(.is-in) { opacity: 0; }
.fv-wait { color: #A8A9AF; font-size: .9rem; }

.fv-pdf { position: absolute; inset: 0; overflow: auto; touch-action: pan-x pan-y; outline: none; overscroll-behavior: contain; }
.fv-pdf .pdfViewer { padding: 4px 0 28px; }
.fv-pdf .pdfViewer .page { margin: 0 auto 14px; box-shadow: 0 1px 3px rgba(0, 0, 0, .5), 0 10px 30px rgba(0, 0, 0, .35); }
.fv-pdf-wait { position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .8rem; padding: 4px 16px 16px; background: #0E0F11; pointer-events: none; }
.fv-pdf-wait img { min-height: 0; max-width: min(100%, 900px); max-height: calc(100% - 2.5rem); object-fit: contain; opacity: .75; box-shadow: 0 10px 30px rgba(0, 0, 0, .35); }

.fv-vid { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.fv-vid:fullscreen { background: #000; padding: 16px; }
.fv-video { display: block; max-width: 100%; max-height: calc(100% - 56px); background: #000; border-radius: 6px; cursor: pointer; }
.fv-vbar { display: flex; align-items: center; gap: .3rem; max-width: 100%; min-width: 0; }
.fv-time { padding: 0 .3rem; font-size: .8rem; color: #C8C9CD; font-variant-numeric: tabular-nums; white-space: nowrap; }
.fv-seek { flex: 1; min-width: 48px; height: 28px; margin: 0 .3rem; accent-color: #FFDA24; cursor: pointer; }
.fv-seek:focus-visible { outline: 2px solid #FFDA24; outline-offset: 2px; }
.fv-audio { display: grid; gap: 1rem; justify-items: center; font-size: 3rem; }

.fv-card { max-width: 400px; margin: 1rem; padding: 1.6rem 1.5rem; display: grid; gap: .55rem; justify-items: center; text-align: center; border-radius: 16px; background: rgba(255, 255, 255, .06); }
.fv-card-icon { font-size: 2.4rem; line-height: 1; }
.fv-card strong { font-size: 1.05rem; }
.fv-card p { margin: 0; color: #B9BABF; font-size: .9rem; line-height: 1.45; }
.fv-card-actions { display: flex; flex-wrap: wrap; gap: .5rem; justify-content: center; margin-top: .5rem; }
.fv-pill { display: inline-flex; align-items: center; min-height: 40px; padding: 0 1.05rem; border: 0; border-radius: 999px; background: #FFFFFF; color: #141518; font: inherit; font-size: .9rem; font-weight: 600; text-decoration: none; cursor: pointer; }
.fv-pill.is-quiet { background: rgba(255, 255, 255, .12); color: #F2F2F3; }
.fv-pill[disabled] { opacity: .6; cursor: default; }

.fv-foot { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: .75rem; min-height: 70px; padding: .4rem 1rem; padding-bottom: max(.4rem, env(safe-area-inset-bottom)); }
.fv-foot-start { display: flex; align-items: center; gap: .9rem; min-width: 0; }
.fv-page, .fv-note { font-size: .84rem; color: #C8C9CD; font-variant-numeric: tabular-nums; }
.fv-note { color: #A8A9AF; }
.fv-pnav { display: none; }
.fv-strip { display: flex; gap: 6px; max-width: min(62vw, 760px); overflow-x: auto; padding: 4px; scrollbar-width: none; }
.fv-strip::-webkit-scrollbar { display: none; }
.fv-thumb { position: relative; flex: none; width: 54px; height: 54px; padding: 0; border: 0; border-radius: 8px; overflow: hidden; background: rgba(255, 255, 255, .08); opacity: .55; cursor: pointer; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06); transition: opacity .15s; }
.fv-thumb[aria-current="true"] { opacity: 1; box-shadow: 0 0 0 2px #FFFFFF; }
.fv-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fv-thumb-icon { display: grid; place-items: center; height: 100%; font-size: 1.3rem; }
.fv-thumb-kind { position: absolute; left: 3px; bottom: 3px; padding: 1px 4px; border-radius: 4px; background: rgba(14, 15, 17, .82); color: #FFFFFF; font-size: .6rem; font-weight: 700; letter-spacing: .02em; line-height: 1.3; }
.fv-tools { grid-column: 3; justify-self: end; display: flex; align-items: center; gap: .15rem; } /* right, with or without the strip */
.fv-pct { width: auto; min-width: 62px; padding: 0 .5rem; font-size: .84rem; font-variant-numeric: tabular-nums; }
/* Hover only where there's a mouse: on a phone a tapped arrow would stay lit */
@media (hover: hover) {
  .fv-btn:hover:not([disabled]) { background: rgba(255, 255, 255, .1); }
  .fv-side .fv-nav:hover:not([disabled]) { background: rgba(255, 255, 255, .16); }
  .fv-thumb:hover { opacity: .85; }
}
.fv-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

@media (max-width: 768px) {
  .fv-bar { gap: .4rem; padding-left: .85rem; padding-right: .35rem; }
  .fv-bar .fv-count, .fv-side, .fv-strip { display: none; }
  .fv-stage { grid-template-columns: minmax(0, 1fr); }
  .fv-stage > .fv-media, .fv-stage > .fv-media:only-child { grid-column: 1; margin: 0; }
  .fv-foot { grid-template-columns: minmax(0, 1fr) auto; min-height: 60px; padding: .35rem .5rem; padding-bottom: max(.35rem, env(safe-area-inset-bottom)); }
  .fv-foot-start { gap: .5rem; flex-wrap: wrap; }
  .fv-pnav { display: flex; align-items: center; gap: .1rem; }
  .fv-tools { grid-column: 2; }
  .fv-btn { width: 44px; height: 44px; }
  .fv-pct { display: none; } /* − and + stay; a pinch or double-tap does the rest */
}
`;
let cssDone = false;
function injectCss() {
  if (cssDone) return;
  const el = document.createElement('style');
  el.id = 'fv-style';
  el.textContent = CSS;
  document.head.appendChild(el);
  cssDone = true;
}
