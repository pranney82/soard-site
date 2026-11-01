/**
 * Admin → Site Config → Anniversary book (site-config.js draws the page
 * list, the Save bar and History; this is the page's own editor).
 * ===========================================================================
 *   - The book: drop the PDF in. ./book-process.js reads it here in the
 *     browser and each page goes up to Cloudflare Images as it's ready, the
 *     PDF itself to R2 in parts (/api/book-admin), while the page fills with
 *     the pages as they come. It keeps going if you open another area of
 *     the admin; closing the tab stops it, and the admin asks first.
 *     Uploads from earlier PDFs that are neither saved nor live are cleared
 *     away when a new one starts.
 *   - On the page: on the site or not, the address, the words above the book.
 *   - Chapters: from the PDF's bookmarks when it has them; edit, add, remove.
 *   - Preview: the real reader (/admin/book-template/) with what's here now.
 * Nothing reaches the site until Save and Publish, like the rest of Site Config.
 *
 * The book's document: { show, slug, eyebrow, title, description, insetPage,
 * version, pages: [{ id, w, h, text, links }], chapters: [{ title, page }],
 * chaptersEdited (once someone has: a new PDF's bookmarks then wait to be
 * asked for), pdf: { url, name, bytes }, textUrl, uploadedAt, spreadsCut }
 * (src/utils/book.ts reads it).
 */

import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';
import * as P from './book-process.js';
import { pageByKey } from './site-config-shared.js';

const html = htm.bind(h);
const CF = '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ';
const DEFAULT_SLUG = '15-years';
const DEFAULTS = {
  eyebrow: '15th anniversary',
  title: '15 Years of <em>Sunshine</em>',
  description: 'The story of Sunshine on a Ranney Day, from the first room in 2012 to today. Turn the pages here, or download the PDF to keep.',
};
const PART = 16 * 1024 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set(['index', '404', '500', 'admin', 'api', 'files', 'apply', 'live', 'control-room', 'og', 'kids', 'about', 'events', 'community', 'partners', 'resources', 'donate', 'faq', 'shop', 'trade-partners', 'advisory-board', 'how-it-works', 'reveals', 'publicity', 'privacy-policy', 'terms', 'branding', 'ways-to-give', 'sunny-and-ranney', 'profile-update', 'cdn-cgi', 'fonts', 'financials', 'book-version.json']);

// Addresses another page answers at (the Address field asks the site), and the book's live one, which is its own
const taken = new Set();
let liveSlug = null;
/** What's wrong with an address, or null: Site Config won't save over it (site-config.js PROBLEMS) */
const SLUG_MAX = 60;
export function bookAddressProblem(value) {
  const v = value ?? DEFAULT_SLUG;
  if (!v) return 'Give the page an address, like 15-years';
  if (v.length > SLUG_MAX) return `Keep it to ${SLUG_MAX} characters or fewer`;
  if (!SLUG.test(v)) return 'Letters, numbers and single dashes, like 15-years';
  if (v !== liveSlug && (RESERVED.has(v) || taken.has(v))) return 'Another page already uses that address';
  return null;
}

export const pageThumb = (page, w = 200) => (page?.id ? `${CF}/${page.id.split('/').map(encodeURIComponent).join('/')}/w=${w},q=75` : '');
const sizeText = (b) => { const n = Number(b) || 0; return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e7 ? `${Math.round(n / 1e6)} MB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`; };
const dayText = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const minutes = (ms) => { const s = Math.round(ms / 1000); return s < 50 ? 'Less than a minute left' : s < 90 ? 'About a minute left' : `About ${Math.round(s / 60)} minutes left`; };
const newVersion = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 14);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, { signal } = {}) {
  let r;
  try {
    r = await fetch(path, body instanceof Blob || body instanceof ArrayBuffer || body instanceof FormData
      ? { method: 'POST', body, signal }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return { success: false, error: 'No connection. Check your internet and try again.', status: 0 };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: /cloudflareaccess/i.test(r.url || '') ? 'Your admin session expired. Reload the page and sign in again.' : `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  j.status = r.status;
  return j;
}
/** Try again after a moment, a few times, for anything but a refusal */
async function retry(fn, signal, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    last = await fn();
    if (last.success || (last.status >= 400 && last.status < 500 && last.status !== 408 && last.status !== 429)) return last;
    await sleep(600 * 2 ** i);
  }
  return last;
}

// ─── The job: one at a time, kept outside the screen so it carries on ─

const job = { state: 'idle', step: '', done: 0, total: 0, pdfDone: 0, pdfTotal: 0, thumbs: [], error: '', result: null, file: null, started: 0, abort: null, applied: false };
const subs = new Set();
const emit = () => { const snap = { ...job, thumbs: [...job.thumbs] }; subs.forEach((f) => f(snap)); };
function useJob() {
  const [s, set] = useState(() => ({ ...job, thumbs: [...job.thumbs] }));
  useEffect(() => { subs.add(set); return () => subs.delete(set); }, []);
  return s;
}
// Closing the tab mid-way would stop it
window.addEventListener('beforeunload', (e) => { if (job.state === 'working') { e.preventDefault(); e.returnValue = ''; } });

/**
 * Upload the PDF in parts; onBytes(sent) as it goes. `up` keeps the upload's
 * place ({ key, uploadId, parts }), so a try after a dropped connection
 * carries on from the last part that arrived; Stop throws the parts away.
 */
async function uploadPdf(file, version, onBytes, signal, up) {
  if (!up.uploadId) {
    const start = await retry(() => post('/api/book-admin', { action: 'pdf-start', version, name: file.name, bytes: file.size }, { signal }), signal);
    if (!start.success) throw new Error(start.error || 'The PDF couldn’t start uploading');
    Object.assign(up, { key: start.key, uploadId: start.uploadId, parts: [] });
  }
  try {
    for (let n = up.parts.length + 1, at = up.parts.length * PART; at < file.size; n++, at += PART) {
      const blob = file.slice(at, Math.min(file.size, at + PART));
      const q = `?action=pdf-part&key=${encodeURIComponent(up.key)}&uploadId=${encodeURIComponent(up.uploadId)}&part=${n}`;
      const j = await retry(() => post(`/api/book-admin${q}`, blob, { signal }), signal);
      if (!j.success) throw new Error(j.error || 'Part of the PDF didn’t upload');
      up.parts.push({ part: j.part, etag: j.etag });
      onBytes(at + blob.size);
    }
    const done = await retry(() => post('/api/book-admin', { action: 'pdf-finish', key: up.key, uploadId: up.uploadId, parts: up.parts }, { signal }), signal);
    if (!done.success) throw new Error(done.error || 'The PDF didn’t finish uploading');
    return { url: done.url, name: up.key.split('/').pop(), bytes: done.bytes || file.size };
  } catch (e) {
    if (e?.name === 'AbortError') {
      post('/api/book-admin', { action: 'pdf-abort', key: up.key, uploadId: up.uploadId }).catch(() => {});
      up.uploadId = null;
    }
    throw e;
  }
}

/** One page picture into Cloudflare Images under its own id */
async function uploadPage(blob, id, signal) {
  const j = await retry(() => {
    const fd = new FormData();
    fd.append('file', new File([blob], `${id.split('/').pop()}.jpg`, { type: 'image/jpeg' }));
    fd.append('id', id);
    return post('/api/upload-image', fd, { signal });
  }, signal);
  // Sent twice (an answer lost on the way back): it's there already
  if (!j.success && !/already exists|exists/i.test(j.error || '')) throw new Error(j.error || `Page ${id.split('/').pop()} didn’t upload`);
}

/** Uploads from earlier PDFs that aren't the saved book or the live one go */
/** Why a file wouldn't open, in words for the person who chose it (pdf.js says "Invalid PDF structure") */
function unreadable(e) {
  const why = e?.name === 'PasswordException'
    ? 'it has a password. Save a copy without one and drop that in'
    : 'it isn’t a PDF this can read. Export it again as a PDF and drop that in';
  return Object.assign(new Error(why), { unreadable: true });
}

async function clearOld(keep) {
  const j = await post('/api/book-admin', { action: 'old-versions', keep: [...keep].filter(Boolean) });
  if (!j.success) return;
  for (const v of j.versions || []) {
    let ok = true;
    for (const id of v.images || []) {
      const r = await post('/api/delete-image', { imageId: id });
      if (!r.success && !/not.?found|could not find|does not exist/i.test(r.error || '')) ok = false;
    }
    if (ok) await post('/api/book-admin', { action: 'drop-version', version: v.version });
  }
}

/** What's on the live site now: { version, slug } (the build writes /book-version.json) */
async function liveBook() {
  try {
    const r = await fetch('/book-version.json', { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function savedVersion() {
  try {
    const r = await fetch('/api/read-content?path=src/content/site/book.json', { cache: 'no-store' });
    const j = await r.json();
    const d = typeof j.content === 'string' ? JSON.parse(j.content) : j.content;
    return d?.version || null;
  } catch { return null; }
}

const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;

/**
 * Read the PDF, send its pages and the file up, and leave the result in
 * job.result. A run that fails (a dropped connection) leaves its place in
 * job.resume: trying the same file again skips every page and part that
 * already went up.
 */
export async function makeBook(file, keep = []) {
  if (job.state === 'working') return;
  const ac = new AbortController();
  const { signal } = ac;
  const resume = job.resume?.key === fileKey(file) ? job.resume : null;
  if (!resume) for (const t of job.thumbs) if (t) URL.revokeObjectURL(t);
  const st = resume || { key: fileKey(file), file, version: newVersion(), pages: [], runs: [], uploaded: [], done: new Set(), pdf: {} };
  job.resume = null;
  Object.assign(job, { state: 'working', step: 'Opening the PDF', done: st.done.size, total: 0, pdfDone: Math.min(file.size, (st.pdf.parts?.length || 0) * PART), pdfTotal: file.size, thumbs: resume ? job.thumbs : [], error: '', result: null, file: { name: file.name, size: file.size }, started: Date.now(), abort: () => ac.abort(), applied: false });
  emit();
  const { version, uploaded } = st;
  try {
    // Old uploads go while this one runs (never the saved book, the live one, the one on screen, nor this one;
    // the server also keeps any History can put back and any from the last day)
    Promise.all([savedVersion(), liveBook()]).then(([saved, live]) => clearOld(new Set([saved, live?.version, version, ...keep]))).catch(() => {});

    let pdf;
    try { pdf = await P.openPdf(file); } catch (e) { throw unreadable(e); }
    const sizes = await P.pageSizes(pdf);
    const plan = P.planPages(sizes);
    if (!plan.pages.length) throw new Error('That PDF has no pages');
    const size = P.pixelSize(plan.pageW, plan.pageH);
    const chapters = P.chaptersFrom(await P.readOutline(pdf), plan);
    Object.assign(job, { total: plan.pages.length, step: 'Preparing the pages' });
    emit();

    const pdfUp = st.pdf.info ? Promise.resolve(st.pdf.info) : uploadPdf(file, version, (b) => { job.pdfDone = b; emit(); }, signal, st.pdf).then((info) => (st.pdf.info = info));
    pdfUp.catch(() => {});
    const { pages, runs } = st;
    // Pictures go up three at a time while the next pages are drawn
    const inFlight = new Set();
    let failed = null;
    const send = (blob, id) => {
      const p = uploadPage(blob, id, signal).then(() => { inFlight.delete(p); st.done.add(id); job.done = st.done.size; emit(); }, (e) => { inFlight.delete(p); failed = failed || e; });
      inFlight.add(p);
      return p;
    };
    const byPdf = new Map();
    plan.pages.forEach((it, i) => { if (!byPdf.has(it.pdf)) byPdf.set(it.pdf, []); byPdf.get(it.pdf).push({ ...it, index: i }); });
    for (const [pdfIndex, items] of byPdf) {
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      if (failed) throw failed;
      // Already up on an earlier try
      if (items.every((it) => pages[it.index] && st.done.has(pages[it.index].id))) continue;
      while (inFlight.size >= 3) await Promise.race(inFlight);
      const out = await P.processPdfPage(pdf, pdfIndex, items, size, plan);
      out.forEach((o, k) => {
        const i = items[k].index;
        const id = `book/${version}/${P.pageName(i)}`;
        pages[i] = { id, w: size.w, h: size.h, text: o.text, ...(o.links.length ? { links: o.links } : {}) };
        runs[i] = o.runs;
        if (!uploaded.includes(id)) uploaded.push(id);
        if (job.thumbs[i]) URL.revokeObjectURL(job.thumbs[i]);
        job.thumbs[i] = URL.createObjectURL(o.thumb || o.blob);
        if (!st.done.has(id)) send(o.blob, id);
      });
      emit();
    }
    await Promise.all([...inFlight]);
    if (failed) throw failed;
    job.step = 'Finishing the PDF’s upload';
    emit();
    const pdfInfo = await pdfUp;
    job.step = 'Saving the words for search';
    emit();
    const [text, manifest] = await Promise.all([
      retry(() => post('/api/book-admin', { action: 'put-json', version, name: 'text', data: { pages: runs } }, { signal }), signal),
      retry(() => post('/api/book-admin', { action: 'put-json', version, name: 'manifest', data: { images: uploaded, pdf: pdfInfo.url, made: new Date().toISOString() } }, { signal }), signal),
    ]);
    if (!manifest.success) throw new Error(manifest.error || 'The book’s list of pages didn’t save');
    pdf.destroy?.();
    job.result = {
      version, pages, chapters, pdf: pdfInfo,
      textUrl: text.success ? text.url : null,
      uploadedAt: new Date().toISOString(),
      spreadsCut: plan.spreads,
    };
    job.state = 'done';
    job.step = '';
    emit();
  } catch (e) {
    const stopped = e?.name === 'AbortError';
    job.state = stopped ? 'idle' : 'failed';
    job.error = stopped ? '' : String(e?.message || 'Something went wrong').replace(/[.\s]+$/, '');
    job.step = '';
    // Try again carries on from here; Stop starts over, and a file that can't be opened has nothing to carry on
    job.resume = stopped || e?.unreadable ? null : st;
    // Until then, what went up is nobody's: the next new upload clears it
    if (uploaded.length) post('/api/book-admin', { action: 'put-json', version, name: 'manifest', data: { images: uploaded, abandoned: true } }).catch(() => {});
    emit();
  }
}

// ─── The screen ────────────────────────────────────────────────────

export function BookPage({ c, ui }) {
  const { Card, TextField, AreaField, InlineRich, Segmented, Icon, Dialog } = ui;
  const d = c.doc('book');
  const pages = Array.isArray(d.pages) ? d.pages : [];
  const n = pages.length;
  const set = (k) => (v) => c.update('book', (e) => ({ ...e, [k]: v }));
  const j = useJob();
  const [live, setLive] = useState(undefined);
  useEffect(() => { liveBook().then(setLive); }, []);
  // The page list's address and "View page" go to the live page, and only once there is one
  useEffect(() => {
    if (live === undefined) return;
    const pg = pageByKey('book');
    const url = live?.live ? `/${live.slug}/` : null;
    if (pg && pg.url !== url) { pg.url = url; c.update('book', (e) => ({ ...e })); }
  }, [live]);

  // A finished job lands in this book once (even when it finished while you were elsewhere in the admin)
  useEffect(() => {
    if (j.state !== 'done' || !job.result || job.applied) return;
    job.applied = true;
    const r = job.result;
    c.update('book', (e) => {
      // Chapters someone wrote stay (the new bookmarks are offered under them); otherwise the new PDF's bookmarks,
      // none when it has none (the old PDF's would point at pages of another book)
      const keepChapters = (Array.isArray(e.chapters) ? e.chapters : []).filter((ch) => Number.isInteger(ch.page) && ch.page < r.pages.length);
      const useMarks = !(e.chaptersEdited && keepChapters.length);
      return {
        ...e,
        version: r.version, pages: r.pages, pdf: r.pdf, textUrl: r.textUrl, uploadedAt: r.uploadedAt, spreadsCut: r.spreadsCut,
        chapters: useMarks ? r.chapters : keepChapters,
        slug: e.slug || DEFAULT_SLUG,
        ...(Number.isInteger(e.insetPage) && e.insetPage >= r.pages.length ? { insetPage: undefined } : {}),
      };
    });
    c.addToast(`The book is ready: ${r.pages.length} ${r.pages.length === 1 ? 'page' : 'pages'}. Save to keep it.`, 'success');
  }, [j.state]);

  const slug = d.slug || DEFAULT_SLUG;
  const liveHere = live?.live && live.slug === slug && live.version === d.version;

  return html`
    <${BookFile} c=${c} ui=${ui} d=${d} j=${j} />
    ${n > 0 && html`
      <${Card} id="sc-book-page" title="On the page" sub="The words above the book, and where the page lives.">
        <div class="bk-onoff">
          <${Segmented} label="On the site" value=${d.show ? 'on' : 'off'} onChange=${(v) => set('show')(v === 'on')} options=${[['off', 'Hidden'], ['on', 'On the site']]} />
          <span class="sc-hint">${d.show
            ? html`Goes live at <strong>sunshineonaranneyday.com/${slug}/</strong> when you save and publish. Nothing links to it until you add a link somewhere.`
            : 'Hidden until you switch it on, save and publish.'}
            ${liveHere ? html` <a class="sc-link" href=${`/${slug}/`} target="_blank" rel="noopener">Open the live page</a>` : ''}</span>
        </div>
        <${Address} value=${d.slug} onChange=${set('slug')} ui=${ui} liveSlug=${live?.live ? live.slug : null} onChecked=${() => c.update('book', (e) => ({ ...e }))} />
        <${TextField} label="Small line above the title" value=${d.eyebrow} onChange=${set('eyebrow')} max=${40} placeholder=${DEFAULTS.eyebrow} hint=${d.eyebrow ? null : `Blank shows “${DEFAULTS.eyebrow}”.`} />
        <${InlineRich} label="Title" value=${d.title || ''} onChange=${set('title')} emClass="highlight" display placeholder="15 Years of Sunshine" hint=${`⌘I highlights a word in yellow.${d.title ? '' : ' Blank shows “15 Years of Sunshine”.'}`} />
        <${AreaField} label="Description" value=${d.description} onChange=${set('description')} rows=${2} max=${240} placeholder=${DEFAULTS.description} hint="Under the title, and what search engines and shared links show." />
        <${InsetPicker} d=${d} c=${c} ui=${ui} />
      <//>
      <${Readers} d=${d} ui=${ui} live=${live} />
      <${Chapters} c=${c} ui=${ui} d=${d} marks=${j.state === 'done' && job.result?.version === d.version ? job.result.chapters : []} />
      <${Preview} d=${d} ui=${ui} />`}`;
}

// The PDF: drop it in, watch it become pages, or see what's there
function BookFile({ c, ui, d, j }) {
  const { Card, Icon } = ui;
  const pages = Array.isArray(d.pages) ? d.pages : [];
  const [over, setOver] = useState(false);
  const input = useRef(null);
  const choose = (f) => {
    if (!f) return;
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { c.addToast('Choose the book as a PDF.', 'error'); return; }
    makeBook(f, [d.version]);
  };
  const drop = {
    onDragOver: (e) => { e.preventDefault(); setOver(true); },
    onDragLeave: () => setOver(false),
    onDrop: (e) => { e.preventDefault(); setOver(false); if (job.state !== 'working') choose(e.dataTransfer?.files?.[0]); },
  };
  const picker = html`<input ref=${input} type="file" accept="application/pdf,.pdf" hidden onChange=${(e) => { const f = e.target.files?.[0]; e.target.value = ''; choose(f); }} />`;
  // A file dropped anywhere else on the screen would open in the tab and leave the admin: it's caught
  // here instead, and taken when it's a PDF and nothing is being prepared
  useEffect(() => {
    const files = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const over = (e) => { if (files(e)) e.preventDefault(); };
    const dropped = (e) => {
      if (!files(e) || e.defaultPrevented) return;
      e.preventDefault();
      if (job.state === 'working') c.addToast('Wait for this PDF to finish, or Stop it first.', 'info');
      else choose(e.dataTransfer.files?.[0]);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', dropped);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', dropped); };
  }, []);

  if (j.state === 'working') return html`<${Card} id="sc-book" title="The book"><${Working} j=${j} ui=${ui} /><//>`;

  const failed = j.state === 'failed' && html`
    <p class="sc-note is-warn" role="alert"><${Icon} name="warn" /> ${j.file?.name || 'The PDF'} didn’t finish: ${j.error}. Nothing on the site changed.${' '}
      ${job.resume
        ? html`<button type="button" class="sc-link" onClick=${() => makeBook(job.resume.file, [d.version])}>Try again</button>${' '}(${j.total && job.resume.done.size >= j.total ? 'it carries on with the PDF’s upload' : `it carries on from page ${job.resume.done.size + 1}${j.total ? ` of ${j.total}` : ''}`})`
        : html`<button type="button" class="sc-link" onClick=${() => input.current?.click()}>Choose another PDF</button>`}</p>`;

  if (!pages.length) return html`
    <${Card} id="sc-book" title="The book" sub="Drop in the finished PDF. It becomes a flip book people can read on the site, and the PDF is there to download.">
      ${failed}
      <div class=${`bk-drop ${over ? 'is-over' : ''}`} ...${drop}>
        <svg class="bk-drop-art" viewBox="0 0 120 84" aria-hidden="true"><path d="M60 14C48 6 30 5 12 8v64c18-3 36-2 48 6 12-8 30-9 48-6V8c-18-3-36-2-48 6Z" /><path d="M60 14v64" /></svg>
        <p class="bk-drop-title">Drop the book’s PDF here</p>
        <p class="sc-hint">Any size, print-ready files too. Its pages, words, links and bookmarks all come from the file.</p>
        <button type="button" class="btn btn-primary" onClick=${() => input.current?.click()}><${Icon} name="upload" size=${16} /> Choose the PDF</button>
        ${picker}
      </div>
    <//>`;

  const cover = pages[0];
  const notes = [
    d.spreadsCut ? `${d.spreadsCut} two-page spread${d.spreadsCut === 1 ? ' was' : 's were'} cut into single pages` : null,
    (d.chapters || []).length ? `${d.chapters.length} chapter${d.chapters.length === 1 ? '' : 's'}` : null,
    pages.some((p) => p.links?.length) ? 'links in the book work' : null,
  ].filter(Boolean);
  return html`
    <${Card} id="sc-book" title="The book">
      ${failed}
      <div class=${`bk-have ${over ? 'is-over' : ''}`} ...${drop}>
        <img class="bk-have-cover" src=${pageThumb(cover, 240)} alt="" style=${`aspect-ratio:${cover.w}/${cover.h}`} />
        <div class="bk-have-text">
          <p class="bk-have-name"><${Icon} name="file" size=${15} /> ${d.pdf?.name || 'The book'}</p>
          <p class="bk-have-meta">${pages.length} ${pages.length === 1 ? 'page' : 'pages'}${d.pdf?.bytes ? ` · ${sizeText(d.pdf.bytes)}` : ''}${d.uploadedAt ? ` · added ${dayText(d.uploadedAt)}` : ''}</p>
          ${notes.length > 0 && html`<p class="sc-hint">${notes.join(' · ')}</p>`}
          <div class="bk-have-actions">
            <button type="button" class="btn btn-ghost btn-sm" onClick=${() => input.current?.click()}><${Icon} name="upload" size=${14} /> Replace the PDF</button>
            ${d.pdf?.url && html`<a class="btn btn-ghost btn-sm" href=${d.pdf.url} target="_blank" rel="noopener">Open the PDF <${Icon} name="ext" size=${12} /></a>`}
          </div>
          <p class="sc-hint">Or drop a new PDF here. The pages on the site change only when you save and publish.</p>
          ${picker}
        </div>
      </div>
      <${PageStrip} pages=${pages} />
    <//>`;
}

function Working({ j, ui }) {
  const pct = j.total ? (j.done / j.total) * 0.92 + (j.pdfTotal ? (j.pdfDone / j.pdfTotal) * 0.08 : 0) : 0;
  const elapsed = Date.now() - j.started;
  const left = j.done >= 3 && pct > 0.04 ? minutes((elapsed / pct) * (1 - pct)) : 'Working out how long';
  const grid = useRef(null);
  // Keep the newest pages in view as they arrive
  useEffect(() => { const g = grid.current; if (g) g.scrollTop = g.scrollHeight; }, [j.thumbs.length]);
  return html`
    <div class="bk-work" aria-busy="true">
      <div class="bk-work-head">
        <div>
          <p class="bk-work-title">${j.total ? `${j.step} · ${Math.min(j.done + 1, j.total)} of ${j.total}` : j.step}</p>
          <p class="sc-hint">${j.file?.name} · ${sizeText(j.file?.size)} · ${left} · keep this tab open (other areas of the admin are fine)</p>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" onClick=${() => j.abort?.()}>Stop</button>
      </div>
      <div class="bk-bar" role="progressbar" aria-label="Preparing the book" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(pct * 100)}>
        <span style=${`transform:scaleX(${pct})`}></span>
      </div>
      ${j.pdfTotal > 0 && html`<p class="sc-hint">The PDF: ${j.pdfDone >= j.pdfTotal ? 'uploaded' : `${Math.round((j.pdfDone / j.pdfTotal) * 100)}% uploaded`}</p>`}
      <div class="bk-work-grid" ref=${grid}>
        ${j.thumbs.map((t, i) => t && html`<img key=${i} src=${t} alt=${`Page ${i + 1}`} class=${i < j.done ? 'is-up' : ''} />`)}
      </div>
    </div>`;
}

/** Every page small, in a row you can scroll */
function PageStrip({ pages }) {
  return html`
    <div class="bk-strip" tabindex="0" aria-label="The pages">
      ${pages.map((p, i) => html`<figure key=${p.id}><img src=${pageThumb(p, 160)} alt="" loading="lazy" style=${`aspect-ratio:${p.w}/${p.h}`} /><figcaption>${i + 1}</figcaption></figure>`)}
    </div>`;
}

// The page's address, checked against every page the site already has
function Address({ value, onChange, ui, liveSlug: live, onChecked }) {
  const { Icon } = ui;
  const v = value ?? DEFAULT_SLUG;
  liveSlug = live;
  // Ask the site whether something already answers there (a page, a Function, a redirect)
  useEffect(() => {
    if (!SLUG.test(v) || RESERVED.has(v) || v === live || taken.has(v)) return undefined;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/${v}/`, { method: 'HEAD', redirect: 'manual', cache: 'no-store' });
        if (r.type === 'opaqueredirect' || r.ok) { taken.add(v); onChecked?.(); }
      } catch { /* can't tell: the build keeps the book off another page's address anyway */ }
    }, 400);
    return () => clearTimeout(t);
  }, [v, live]);
  // While typing, a dash at the end is the start of the next word: it's tidied away when the field is left
  const [typing, setTyping] = useState(false);
  const problem = bookAddressProblem(typing ? v.replace(/-$/, '') || v : v);
  const tidy = (raw, done) => {
    let out = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-/, '');
    if (done) out = out.replace(/-$/, '');
    return out.slice(0, SLUG_MAX + 1);
  };
  return html`
    <div class="sc-field">
      <label class="sc-label" for="bk-slug">Address</label>
      <div class="bk-url">
        <span class="bk-url-host">sunshineonaranneyday.com/</span>
        <input id="bk-slug" class="form-input sc-mono" value=${v} aria-invalid=${problem ? 'true' : 'false'} spellcheck="false" autocomplete="off"
          maxlength=${SLUG_MAX + 1} onFocus=${() => setTyping(true)}
          onInput=${(e) => onChange(tidy(e.target.value, false))}
          onBlur=${(e) => { setTyping(false); const t = tidy(e.target.value, true); if (t !== v) onChange(t); }} />
        <span class="bk-url-host">/</span>
      </div>
      <div class="sc-under">${problem
        ? html`<span class="sc-bad" role="alert">${problem}</span>`
        : html`<span class="sc-hint">${liveSlug && liveSlug !== v ? html`<${Icon} name="warn" size=${12} /> Once published, /${liveSlug}/ stops working.` : 'Where the page lives. Share it, or link to it from any page.'}</span>`}</div>
    </div>`;
}

/** The small page beside the cover, at the top of the page */
function InsetPicker({ d, c, ui }) {
  const pages = d.pages || [];
  const auto = Math.min(pages.length - 1, Math.max(1, Math.round(pages.length / 4)));
  const value = Number.isInteger(d.insetPage) && d.insetPage > 0 && d.insetPage < pages.length ? d.insetPage : auto;
  const [open, setOpen] = useState(false);
  if (pages.length < 2) return null;
  return html`
    <div class="sc-field">
      <span class="sc-label">Page beside the cover</span>
      <div class="bk-inset-row">
        <button type="button" class="bk-inset-btn" onClick=${() => setOpen(true)} aria-label=${`Page ${value + 1}. Choose another`}>
          <img src=${pageThumb(pages[value], 160)} alt="" style=${`aspect-ratio:${pages[value].w}/${pages[value].h}`} />
        </button>
        <span class="sc-hint">Page ${value + 1}${value === d.insetPage ? '' : ' (picked for you)'}. A glimpse inside, overlapping the cover on computers. <button type="button" class="sc-link" onClick=${() => setOpen(true)}>Choose another</button></span>
      </div>
      ${open && html`<${PagePicker} ui=${ui} pages=${pages} value=${value} skip=${[0]} skipWhy="That’s the cover" title="The page beside the cover" onPick=${(p) => { c.update('book', (e) => ({ ...e, insetPage: p })); setOpen(false); }} onClose=${() => setOpen(false)} />`}
    </div>`;
}

/** Pick a page from all of them */
function PagePicker({ ui, pages, value, title, onPick, onClose, skip = [], skipWhy = '' }) {
  const { Dialog } = ui;
  const cur = useRef(null);
  // After the dialog has put its own focus somewhere: the page chosen now is where the keys start
  useEffect(() => { requestAnimationFrame(() => { cur.current?.scrollIntoView({ block: 'center' }); cur.current?.focus(); }); }, []);
  return html`
    <${Dialog} title=${title} onClose=${onClose} wide tall footer=${html`<button type="button" class="btn btn-ghost" onClick=${onClose}>Cancel</button>`}>
      <div class="bk-pick">
        ${pages.map((p, i) => html`
          <button type="button" key=${p.id} ref=${i === value ? cur : null} class=${i === value ? 'is-on' : ''} aria-pressed=${i === value} onClick=${() => onPick(i)}
            disabled=${skip.includes(i)} title=${skip.includes(i) ? skipWhy : null}>
            <img src=${pageThumb(p, 200)} alt="" loading="lazy" style=${`aspect-ratio:${p.w}/${p.h}`} />
            <span>${i + 1}</span>
          </button>`)}
      </div>
    <//>`;
}

function Chapters({ c, ui, d, marks = [] }) {
  const { Card, Icon } = ui;
  const pages = d.pages || [];
  const list = Array.isArray(d.chapters) ? d.chapters : [];
  const [picking, setPicking] = useState(null);
  const setList = (fn) => c.update('book', (e) => ({ ...e, chaptersEdited: true, chapters: fn(Array.isArray(e.chapters) ? e.chapters : []) }));
  const sameAsMarks = JSON.stringify(marks) === JSON.stringify(list.map(({ title, page }) => ({ title, page })));
  const sorted = list.map((ch, i) => ({ ch, i })).sort((a, b) => (a.ch.page ?? 0) - (b.ch.page ?? 0));
  const add = () => {
    const after = list.length ? Math.max(...list.map((x) => x.page || 0)) + 1 : 1;
    setList((l) => [...l, { title: '', page: Math.min(pages.length - 1, after) }]);
    requestAnimationFrame(() => document.querySelector('.bk-ch-row:last-child input')?.focus());
  };
  const remove = (i) => {
    const gone = list[i];
    setList((l) => l.filter((_, k) => k !== i));
    c.addToast(`Removed “${gone.title || 'the chapter'}”.`, 'info', { label: 'Undo', fn: () => setList((l) => [...l.slice(0, i), gone, ...l.slice(i)]) });
  };
  return html`
    <${Card} id="sc-book-chapters" title="Chapters" sub="Listed in the reader’s Contents and marked along its page bar. They come from the PDF’s bookmarks when it has any.">
      ${sorted.length ? html`
        <ol class="bk-ch">
          ${sorted.map(({ ch, i }) => html`
            <li class="bk-ch-row" key=${i}>
              <button type="button" class="bk-ch-page" onClick=${() => setPicking(i)} aria-label=${`p. ${(ch.page ?? 0) + 1}, the page it starts on: change it`}>
                ${pages[ch.page] && html`<img src=${pageThumb(pages[ch.page], 120)} alt="" style=${`aspect-ratio:${pages[ch.page].w}/${pages[ch.page].h}`} />`}
                <span>p. ${(ch.page ?? 0) + 1}</span>
              </button>
              <input class="form-input" value=${ch.title || ''} placeholder="Chapter title" aria-label=${`Chapter ${i + 1} title`} maxlength="120"
                aria-invalid=${String(ch.title || '').trim() ? 'false' : 'true'}
                onInput=${(e) => { const t = e.target.value; setList((l) => l.map((x, k) => (k === i ? { ...x, title: t } : x))); }} />
              <button type="button" class="sc-icon-btn sc-remove" aria-label=${`Remove ${ch.title || 'this chapter'}`} onClick=${() => remove(i)}><${Icon} name="trash" size=${14} /></button>
            </li>`)}
        </ol>` : html`<p class="sc-empty">No chapters. The reader shows every page instead.</p>`}
      ${marks.length > 0 && !sameAsMarks && html`
        <p class="sc-note bk-marks">The new PDF has ${marks.length} bookmark${marks.length === 1 ? '' : 's'}: ${marks.slice(0, 4).map((m) => m.title).join(', ')}${marks.length > 4 ? '…' : ''}.
          <button type="button" class="sc-link" onClick=${() => { const before = list; c.update('book', (e) => ({ ...e, chapters: marks, chaptersEdited: false })); c.addToast('Chapters now follow the PDF’s bookmarks.', 'info', { label: 'Undo', fn: () => c.update('book', (e) => ({ ...e, chapters: before, chaptersEdited: true })) }); }}>Use them instead</button></p>`}
      <button type="button" class="btn btn-ghost btn-sm sc-add" onClick=${add}><${Icon} name="plus" size=${14} /> Add a chapter</button>
      ${picking != null && html`<${PagePicker} ui=${ui} pages=${pages} value=${list[picking]?.page ?? 0} title=${`Where “${list[picking]?.title || 'the chapter'}” starts`}
        onPick=${(p) => { setList((l) => l.map((x, k) => (k === picking ? { ...x, page: p } : x))); setPicking(null); }} onClose=${() => setPicking(null)} />`}
    <//>`;
}

// ─── Readers: what the site counted (functions/api/_book-stats.js) ─
const RANGES = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['0', 'All time']];
const GOLD = '#A27A00'; // one series, validated against the card's white (dataviz validate_palette)
const compact = (x) => { const v = Number(x) || 0; return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}K` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v)); };
const duration = (ms) => { const sec = Math.round((Number(ms) || 0) / 1000); if (sec < 60) return `${sec}s`; const m = Math.floor(sec / 60); return m < 60 ? `${m}m ${String(sec % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const share = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–');
/** 0, a round half, and a round top at or above max (whole: counts and seconds, so the half is a whole number too) */
function ticksFor(max, whole = false) {
  if (!(max > 0)) return [0];
  const mag = 10 ** Math.floor(Math.log10(max));
  const steps = whole ? [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10, 20] : [1, 2, 2.5, 5, 10];
  const top = steps.map((k) => k * mag).find((v) => v >= max && (!whole || Number.isInteger(v / 2)))
    ?? [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= max);
  return [0, top / 2, top];
}
/** Every day from since to today (Atlanta's days, as the counts are kept), the empty ones too */
function everyDay(days, since, today) {
  if (!since) return days;
  const have = new Map(days.map((x) => [x.day, x]));
  const last = today || new Date().toISOString().slice(0, 10);
  const out = [];
  for (let t = Date.parse(`${since}T12:00:00Z`); out.length < 3700; t += 864e5) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day > last) break;
    out.push(have.get(day) || { day, visits: 0, readers: 0 });
  }
  return out;
}
const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** Columns of one series: hover or arrow keys for each value, the numbers in a table under it */
function Columns({ items, format, label, whole = false, height = 132 }) {
  const [at, setAt] = useState(null);
  const bars = useRef(null);
  const tip = useRef(null);
  const ticks = ticksFor(Math.max(0, ...items.map((it) => it.value)), whole);
  const top = ticks[ticks.length - 1] || 1;
  const pick = (x) => { const r = bars.current?.getBoundingClientRect(); if (r?.width) setAt(Math.min(items.length - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * items.length)))); };
  const key = (e) => {
    const k = { ArrowRight: 1, ArrowLeft: -1, Home: -1e9, End: 1e9 }[e.key];
    if (k == null) return;
    e.preventDefault();
    setAt((i) => Math.min(items.length - 1, Math.max(0, (i ?? items.length - 1) + k)));
  };
  const on = at != null ? items[at] : null;
  // The word over a column stays inside the chart: centred on it, unless that would hang off an end
  useEffect(() => {
    const t = tip.current, plot = bars.current?.parentElement;
    if (!t || !plot || at == null) return;
    const W = plot.clientWidth, w = t.offsetWidth, x = ((at + 0.5) / items.length) * W;
    t.style.left = `${Math.max(0, Math.min(W - w, x - w / 2))}px`;
    t.style.transform = 'none';
  }, [at, items.length]);
  return html`
    <figure class="bk-cols">
      <div class="bk-cols-plot" style=${`height:${height}px`}>
        ${ticks.map((t) => html`<span class="bk-cols-grid" key=${t} style=${`bottom:${(t / top) * 100}%`}><span class="bk-cols-tick">${format(t)}</span></span>`)}
        <div class="bk-cols-bars" ref=${bars} tabindex="0" role="img" aria-label=${label}
          onPointerDown=${(e) => pick(e.clientX)} onPointerMove=${(e) => pick(e.clientX)} onPointerLeave=${(e) => { if (e.pointerType === 'mouse') setAt(null); }}
          onKeyDown=${key} onFocus=${() => setAt((i) => i ?? items.length - 1)} onBlur=${() => setAt(null)}>
          ${items.map((it, i) => html`<span key=${it.key} class=${`bk-col ${i === at ? 'is-on' : ''}`} style=${`height:${(it.value / top) * 100}%`}></span>`)}
        </div>
        ${on && html`<div class="bk-tip" ref=${tip} role="status" style=${`left:${((at + 0.5) / items.length) * 100}%`}><strong>${format(on.value)}</strong><span>${on.title}</span></div>`}
      </div>
      <figcaption class="bk-cols-x"><span>${items[0]?.short}</span><span>${items[items.length - 1]?.short}</span></figcaption>
    </figure>`;
}

function Readers({ d, ui, live }) {
  const { Card, Segmented } = ui;
  const [range, setRange] = useState('30');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  // Page by page follows the upload that's on the site (the saved one until there is one)
  const version = (live?.live && live.version) || d.version || '';
  useEffect(() => {
    let gone = false;
    setLoading(true);
    fetch(`/api/book-stats-admin?days=${range}&version=${encodeURIComponent(version)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (gone) return; if (j.success) { setData(j); setErr(null); } else setErr(j.error || 'Couldn’t load the numbers'); })
      .catch(() => { if (!gone) setErr('No connection. The numbers will be here when there is one.'); })
      .finally(() => { if (!gone) setLoading(false); });
    return () => { gone = true; };
  }, [range, version]);

  const pages = d.pages || [];
  const n = pages.length;
  const t = data?.totals || {};
  const reach = data?.pages?.reach || {};
  const views = data?.pages?.views || {};
  const ms = data?.pages?.ms || {};
  // How many got at least as far as each page: everyone whose furthest page is there or later
  const opened = Object.values(reach).reduce((x, v) => x + Math.max(0, v), 0);
  const reached = new Array(n).fill(0);
  for (let p = n - 1, acc = 0; p >= 0; p--) { acc += Math.max(0, reach[p] || 0); reached[p] = acc; }
  const avgMs = (p) => (views[p] ? ms[p] / views[p] : 0);
  const days = data ? everyDay(data.days || [], data.since, data.today) : [];
  const devices = Object.entries(data?.devices || {}).sort((a, b) => b[1] - a[1]);
  const deviceTotal = devices.reduce((x, [, v]) => x + v, 0);
  const shares = Object.entries(data?.shares || {}).sort((a, b) => b[1] - a[1]);
  const SHARE_NAMES = { copy: 'Copied link', email: 'Email', facebook: 'Facebook', x: 'X', linkedin: 'LinkedIn', native: 'Phone share' };
  const DEVICE_NAMES = { phone: 'Phones', tablet: 'Tablets', computer: 'Computers' };
  const mostRead = pages.map((_, p) => p).filter((p) => views[p] >= 2).sort((a, b) => avgMs(b) - avgMs(a)).slice(0, 4);
  const empty = data && !t.visits;

  return html`
    <${Card} id="sc-book-readers" title="Readers" sub="Who opened the book and how far they read. Counted without cookies: nothing about any one person is kept.">
      <div class="bk-range"><${Segmented} label="How far back" value=${range} onChange=${setRange} options=${RANGES} /></div>
      ${err && html`<p class="sc-note is-warn" role="alert">${err}</p>`}
      ${empty && html`<p class="sc-empty">No readers ${range === '0' ? 'yet' : `in the last ${range} days`}. Counting starts once the book is on the site.</p>`}
      ${data && !empty && html`
        <div class=${`bk-readers ${loading ? 'is-loading' : ''}`}>
          <div class="bk-kpis">
            ${[
              ['Visits', compact(t.visits)],
              ['Readers', compact(t.readers), 'Turned at least one page'],
              ['Read to the end', share(t.end, t.started), 'Of visits that began at the cover'],
              ['Time reading', duration(t.visits ? t.time / t.visits : 0), 'Average a visit'],
              ['Downloads', compact(t.download)],
              ['Shares', compact(t.share)],
            ].map(([label, value, hint]) => html`
              <div class="bk-kpi" key=${label}><span class="bk-kpi-label">${label}</span><span class="bk-kpi-value">${value}</span>${hint && html`<span class="bk-kpi-hint">${hint}</span>`}</div>`)}
          </div>

          <h4 class="sc-h4">Visits each day</h4>
          <${Columns} label=${`Visits each day: ${days.map((x) => `${dayName(x.day)} ${x.visits}`).join(', ')}`} format=${compact} whole
            items=${days.map((x) => ({ key: x.day, value: x.visits, title: `${dayName(x.day)} · ${x.visits === 1 ? 'visit' : 'visits'}, ${x.readers} ${x.readers === 1 ? 'reader' : 'readers'}`, short: dayName(x.day) }))} />

          ${n > 0 && opened > 0 && html`
            <h4 class="sc-h4">How far people read</h4>
            <${Columns} label="Of the visits that began at the cover, the share that got at least this far, page by page" format=${(v) => `${Math.round(v)}%`}
              items=${reached.map((r, p) => ({ key: p, value: (r / opened) * 100, title: `Page ${p + 1}: ${r} of ${opened} got this far`, short: `Page ${p + 1}` }))} />
            <h4 class="sc-h4">Time on each page</h4>
            <${Columns} label="Average time on each page" format=${(v) => duration(v * 1000)} whole
              items=${pages.map((_, p) => ({ key: p, value: avgMs(p) / 1000, title: `Page ${p + 1} · ${views[p] || 0} views`, short: `Page ${p + 1}` }))} />
            ${mostRead.length > 0 && html`
              <h4 class="sc-h4">Where readers linger</h4>
              <ol class="bk-top">
                ${mostRead.map((p) => html`<li key=${p}><img src=${pageThumb(pages[p], 120)} alt="" style=${`aspect-ratio:${pages[p].w}/${pages[p].h}`} /><span><strong>${duration(avgMs(p))}</strong> on page ${p + 1}</span></li>`)}
              </ol>`}
            <details class="bk-table">
              <summary>See the numbers, page by page</summary>
              <table>
                <thead><tr><th scope="col">Page</th><th scope="col">Views</th><th scope="col">Average time</th><th scope="col">Got this far</th></tr></thead>
                <tbody>${pages.map((_, p) => html`<tr key=${p}><th scope="row">${p + 1}</th><td>${views[p] || 0}</td><td>${duration(avgMs(p))}</td><td>${share(reached[p], opened)}</td></tr>`)}</tbody>
              </table>
            </details>`}

          <div class="bk-lists">
            ${deviceTotal > 0 && html`<div><h4 class="sc-h4">On</h4><ul>${devices.map(([k, v]) => html`<li key=${k}><span>${DEVICE_NAMES[k] || k}</span><strong>${share(v, deviceTotal)}</strong></li>`)}</ul></div>`}
            ${(data.from || []).length > 0 && html`<div><h4 class="sc-h4">Came from</h4><ul>${data.from.map((x) => html`<li key=${x.key}><span>${x.key}</span><strong>${x.n}</strong></li>`)}</ul></div>`}
            ${(data.links || []).length > 0 && html`<div><h4 class="sc-h4">Links followed</h4><ul>${data.links.map((x) => html`<li key=${x.key}><span>${x.key}</span><strong>${x.n}</strong></li>`)}</ul></div>`}
            ${shares.length > 0 && html`<div><h4 class="sc-h4">Shared by</h4><ul>${shares.map(([k, v]) => html`<li key=${k}><span>${SHARE_NAMES[k] || k}</span><strong>${v}</strong></li>`)}</ul></div>`}
          </div>
        </div>`}
    <//>`;
}

// The real reader, with what's on this screen now
function Preview({ d, ui }) {
  const { Card } = ui;
  const frame = useRef(null);
  const [ready, setReady] = useState(false);
  const data = useMemo(() => ({
    title: String(d.title || DEFAULTS.title).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'),
    pages: (d.pages || []).map((p) => ({ id: p.id, w: p.w, h: p.h, text: p.text || '', ...(p.links?.length ? { links: p.links } : {}) })),
    chapters: (d.chapters || []).filter((ch) => String(ch.title || '').trim() && Number.isInteger(ch.page)),
    pdf: d.pdf || null,
    textUrl: d.textUrl || null,
  }), [d.title, d.pages, d.chapters, d.pdf, d.textUrl]);
  useEffect(() => {
    const on = (e) => { if (e.source === frame.current?.contentWindow && e.data?.type === 'soard-book-ready') setReady(true); };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  useEffect(() => {
    if (!ready) return undefined;
    const t = setTimeout(() => frame.current?.contentWindow?.postMessage({ type: 'soard-book', book: data }, location.origin), 250);
    return () => clearTimeout(t);
  }, [ready, data]);
  return html`
    <${Card} id="sc-book-preview" title="Preview" sub="The reader as it is on this screen, saved or not. Drag a corner, click a page, or use the arrow keys.">
      <div class="bk-frame">
        <iframe ref=${frame} src="/admin/book-template/" title="The book’s reader" allow="fullscreen" loading="lazy"></iframe>
      </div>
    <//>`;
}

export const BOOK_CSS = `
#sc-book, #sc-book-page, #sc-book-chapters, #sc-book-preview { min-width: 0; }
.bk-drop { display: grid; justify-items: center; gap: .55rem; padding: 2.75rem 1.5rem 2.25rem; border: 2px dashed var(--color-border-strong); border-radius: 16px; text-align: center; background: var(--color-bg-secondary); transition: border-color .15s ease, background-color .15s ease; }
.bk-drop.is-over, .bk-have.is-over { border-color: var(--color-primary); background: var(--color-primary-bg); }
.bk-drop-art { width: 92px; height: 64px; fill: none; stroke: var(--color-text-muted); stroke-width: 2.4; stroke-linejoin: round; margin-bottom: .35rem; }
.bk-drop-title { margin: 0; font-weight: 700; font-size: var(--fs-md); color: var(--color-text); }
.bk-drop .sc-hint { max-width: 420px; margin: 0 0 .6rem; }
.bk-drop .btn { display: inline-flex; align-items: center; gap: .45rem; }
.bk-have { display: grid; grid-template-columns: 116px minmax(0, 1fr); gap: 1.25rem; align-items: start; padding: .25rem; border: 2px dashed transparent; border-radius: 14px; transition: border-color .15s ease, background-color .15s ease; }
.bk-have-cover { width: 116px; height: auto; display: block; border-radius: 2px 5px 5px 2px; background: #fff; box-shadow: 1px 1px 0 #E7E1D3, 2px 2px 0 #FBF8F0, 3px 3px 0 #E2DCCB, 0 10px 24px rgba(0,0,0,.14); }
.bk-have-text { display: grid; gap: .3rem; min-width: 0; }
.bk-have-name { display: flex; align-items: center; gap: .4rem; margin: 0; font-weight: 700; color: var(--color-text); overflow-wrap: anywhere; }
.bk-have-meta { margin: 0; font-size: var(--fs-sm); color: var(--color-text-secondary); }
.bk-have-actions { display: flex; flex-wrap: wrap; gap: .4rem; margin: .45rem 0 .1rem; }
.bk-have-actions .btn { display: inline-flex; align-items: center; gap: .35rem; }
.bk-strip { display: flex; gap: .55rem; margin-top: 1.25rem; padding: .25rem .1rem .75rem; overflow-x: auto; scroll-snap-type: x proximity; scrollbar-width: thin; }
.bk-strip:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); border-radius: 8px; }
.bk-strip figure { margin: 0; flex: 0 0 auto; display: grid; gap: .25rem; justify-items: center; scroll-snap-align: start; }
.bk-strip img { height: 92px; width: auto; display: block; background: #fff; box-shadow: 0 0 0 1px var(--color-border), 0 2px 6px rgba(0,0,0,.08); }
.bk-strip figcaption { font-size: var(--fs-2xs); color: var(--color-text-muted); font-variant-numeric: tabular-nums; }

.bk-work { display: grid; gap: .75rem; }
.bk-work-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
.bk-work-title { margin: 0 0 .15rem; font-weight: 700; color: var(--color-text); font-variant-numeric: tabular-nums; }
.bk-work-head .sc-hint { margin: 0; }
.bk-bar { height: 8px; border-radius: 99px; background: color-mix(in srgb, var(--color-text) 8%, transparent); overflow: hidden; }
.bk-bar span { display: block; height: 100%; background: var(--color-primary); transform-origin: 0 50%; transition: transform .4s cubic-bezier(.2,.7,.3,1); }
.bk-work-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: .5rem; max-height: 300px; overflow-y: auto; padding: .25rem; scroll-behavior: smooth; }
.bk-work-grid img { width: 100%; height: auto; display: block; background: #fff; box-shadow: 0 0 0 1px var(--color-border); opacity: .45; animation: bkIn .35s cubic-bezier(.2,.7,.3,1) both; transition: opacity .3s ease; }
.bk-work-grid img.is-up { opacity: 1; }
@keyframes bkIn { from { transform: translateY(6px) scale(.96); } }

.bk-onoff { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; margin-bottom: 1.15rem; }
.bk-onoff .sc-seg { margin-bottom: 0; }
.bk-onoff .sc-hint { flex: 1; min-width: 220px; font-size: var(--fs-sm); }
.bk-url { display: flex; align-items: center; gap: .15rem; }
.bk-url .form-input { flex: 1; min-width: 6rem; }
.bk-url-host { color: var(--color-text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs); white-space: nowrap; }
.bk-inset-row { display: flex; align-items: center; gap: .9rem; }
.bk-inset-btn { flex-shrink: 0; padding: 0; border: 0; background: none; cursor: pointer; border-radius: 4px; }
.bk-inset-btn img { width: 64px; height: auto; display: block; background: #fff; box-shadow: 0 0 0 1px var(--color-border), 0 3px 10px rgba(0,0,0,.1); transform: rotate(-3deg); transition: transform .2s ease; }
.bk-inset-btn:hover img { transform: rotate(0); }
.bk-inset-btn:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }

.bk-pick { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: .9rem .7rem; }
.bk-pick button { display: grid; gap: .3rem; justify-items: center; padding: .4rem; border: 0; border-radius: 10px; background: none; color: var(--color-text-secondary); font: inherit; font-size: var(--fs-2xs); cursor: pointer; font-variant-numeric: tabular-nums; }
.bk-pick button:hover:not(:disabled) { background: var(--color-bg-hover); }
.bk-pick button:disabled { opacity: .4; cursor: not-allowed; }
.bk-pick button:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.bk-pick img { width: 100%; height: auto; display: block; background: #fff; box-shadow: 0 0 0 1px var(--color-border), 0 2px 8px rgba(0,0,0,.08); }
.bk-pick button.is-on { color: var(--color-text); font-weight: 700; }
.bk-pick button.is-on img { box-shadow: 0 0 0 3px var(--color-primary), 0 2px 8px rgba(0,0,0,.08); }

.bk-ch { list-style: none; margin: 0 0 .5rem; padding: 0; display: grid; gap: .4rem; }
.bk-ch-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: .75rem; align-items: center; padding: .35rem .4rem; border-radius: 10px; }
.bk-ch-row:hover { background: var(--color-bg-hover); }
.bk-ch-page { display: flex; align-items: center; gap: .5rem; padding: .2rem .5rem .2rem .2rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-card); color: var(--color-text-secondary); font: inherit; font-size: var(--fs-2xs); font-weight: 600; cursor: pointer; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bk-ch-page:hover { border-color: var(--color-border-strong); color: var(--color-text); }
.bk-ch-page:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.bk-ch-page img { width: 28px; height: auto; display: block; background: #fff; box-shadow: 0 0 0 1px var(--color-border); }

.bk-range { margin-bottom: .9rem; }
.bk-range .sc-seg { margin-bottom: 0; }
.bk-readers { transition: opacity .2s ease; }
.bk-readers.is-loading { opacity: .55; }
/* Six numbers in one row, two rows of three, or three of two: never five and one left over */
.bk-readers { container-type: inline-size; }
.bk-kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; margin-bottom: .4rem; }
@container (min-width: 480px) { .bk-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (min-width: 960px) { .bk-kpis { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
.bk-kpi { display: grid; gap: .1rem; align-content: start; padding: .8rem .9rem; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-bg-card); }
.bk-kpi-label { font-size: var(--fs-2xs); font-weight: 600; color: var(--color-text-secondary); }
.bk-kpi-value { font-size: 1.6rem; font-weight: 650; letter-spacing: -.01em; color: var(--color-text); line-height: 1.15; }
.bk-kpi-hint { font-size: var(--fs-2xs); color: var(--color-text-muted); }
.bk-cols { margin: 0 0 .25rem; }
.bk-cols-plot { position: relative; margin-left: 2.6rem; }
.bk-cols-grid { position: absolute; left: 0; right: 0; height: 0; border-top: 1px solid var(--color-border); }
.bk-cols-tick { position: absolute; right: calc(100% + .5rem); top: -.55rem; font-size: var(--fs-2xs); color: var(--color-text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bk-cols-bars { position: absolute; inset: 0; display: flex; align-items: flex-end; justify-content: space-around; gap: 2px; outline: none; border-radius: 4px; }
.bk-cols-bars:focus-visible { box-shadow: var(--focus-ring-strong); }
.bk-col { flex: 1 1 0; max-width: 24px; min-width: 1px; background: ${GOLD}; border-radius: 4px 4px 0 0; transition: background-color .12s ease; }
.bk-col.is-on { background: #7E5F00; }
.bk-tip { position: absolute; bottom: calc(100% + 6px); z-index: 2; display: grid; gap: .05rem; padding: .4rem .6rem; border-radius: 8px; background: var(--color-bg-card); box-shadow: 0 0 0 1px var(--color-border), 0 6px 18px rgba(0,0,0,.12); transform: translateX(-50%); white-space: nowrap; pointer-events: none; }
.bk-tip strong { font-size: var(--fs-sm); color: var(--color-text); }
.bk-tip span { font-size: var(--fs-2xs); color: var(--color-text-secondary); }
.bk-cols-x { display: flex; justify-content: space-between; margin: .35rem 0 0 2.6rem; font-size: var(--fs-2xs); color: var(--color-text-muted); }
.bk-top { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: .6rem; }
.bk-top li { display: flex; align-items: center; gap: .6rem; font-size: var(--fs-sm); color: var(--color-text-secondary); }
.bk-top img { width: 44px; height: auto; display: block; background: #fff; box-shadow: 0 0 0 1px var(--color-border); }
.bk-top strong { color: var(--color-text); }
.bk-table { margin: .9rem 0 0; font-size: var(--fs-sm); }
.bk-table summary { cursor: pointer; color: var(--color-text-secondary); font-weight: 600; }
.bk-table table { width: 100%; margin-top: .6rem; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.bk-table th, .bk-table td { padding: .35rem .5rem; border-bottom: 1px solid var(--color-border); text-align: right; }
.bk-table th:first-child { text-align: left; }
.bk-table thead th { font-size: var(--fs-2xs); color: var(--color-text-muted); font-weight: 600; }
.bk-lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0 1.25rem; margin-top: .4rem; }
.bk-lists ul { list-style: none; margin: 0; padding: 0; }
.bk-lists li { display: flex; justify-content: space-between; gap: .75rem; padding: .3rem 0; border-bottom: 1px solid var(--color-border); font-size: var(--fs-sm); color: var(--color-text-secondary); }
.bk-lists li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bk-lists strong { color: var(--color-text); font-variant-numeric: tabular-nums; }

.bk-frame { position: relative; border-radius: 14px; overflow: hidden; background: #1E1F25; box-shadow: 0 0 0 1px var(--color-border); }
.bk-frame iframe { display: block; width: 100%; height: clamp(440px, 70vh, 720px); border: 0; }

@media (max-width: 640px) {
  .bk-have { grid-template-columns: 84px minmax(0, 1fr); gap: .9rem; }
  .bk-have-cover { width: 84px; }
  .bk-url-host:first-child { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .bk-work-grid img { animation: none; }
  .bk-bar span, .bk-inset-btn img { transition: none; }
}
`;
