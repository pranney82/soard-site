/**
 * Scanned scoresheets, in Applications → Applicants → Scores (and a family's Score tab)
 * ===========================================================================
 * Drop in a PDF or photos of scoresheets and the site reads them into
 * scorecards (functions/api/_score-scans.js has the rules for what saves on
 * its own). This side:
 *  - turns each page into a picture here in the browser, one at a time (a
 *    phone runs out of room drawing 36 at once), with a PDF's typed text, and
 *    sends it; progress shows as it goes, and an upload cut off partway picks
 *    up where it stopped;
 *  - "Check these": each sheet that didn't save on its own, its page beside the
 *    ten scores, the unsure ones marked; 1 to 5 sets a score, Enter saves;
 *  - the season's uploads, each with Undo, and each saved sheet with Take off;
 *  - Print scoresheets: SOARD's own sheet, one page per family with its code,
 *    so paper scoring reads back with nothing to guess.
 * Uploads run in a store outside the components, so leaving the Scores view
 * doesn't stop one.
 */

import { h, htm, useState, useEffect, useRef, useMemo, useCallback } from './vendor.js';
import { ask } from './ask.js';
import { criteriaOf, keysOf, rubricOfSeason, totalOf, TOTAL_MAX } from './scoring-shared.js';

const html = htm.bind(h);
const API = '/api/score-scans-admin';
const PAGE_SIDE = 2000;    // a page picture's long side, in pixels: handwriting stays readable
const JPEG_QUALITY = 0.85;
const TEXT_MAX = 8000;
const RETRIES = 4;
const BUSY_WAIT_MS = 6 * 60 * 1000; // longer than the server holds a page for one reading

async function call(path, body) {
  let r;
  try {
    r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    return { success: false, status: 0, error: 'The connection dropped. Check it, then try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  j.status = r.status;
  return j;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const firstName = (p) => String(p?.name || p?.email || '').split(/[\s@.]/)[0] || 'Someone';
const imageUrl = (scan, page) => `${API}?image=${encodeURIComponent(scan)}&page=${page}`;

// ─── A file's pages, as pictures ──────────────────────────────────────

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImage = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);

async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let pdfMod = null;
let pdfWorker = null;
const loadPdf = () => (pdfMod ||= import('./vendor-pdf.js').then((m) => m.pdfjsLib).catch((e) => { pdfMod = null; throw e; }));

async function openPdf(buf) {
  const lib = await loadPdf();
  pdfWorker ||= new lib.PDFWorker();
  const base = new URL('./pdf/', import.meta.url).href;
  return lib.getDocument({ data: new Uint8Array(buf), worker: pdfWorker, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, useWasm: false, enableXfa: false }).promise;
}

/** A canvas as a JPEG data: URL, and the canvas let go (phones have little room for them) */
async function canvasJpeg(canvas) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
  canvas.width = 0; canvas.height = 0;
  if (!blob) throw new Error('This browser couldn’t make a picture of the page.');
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
}

/** Page n of a PDF → { image, text } */
async function pdfPage(doc, n) {
  const page = await doc.getPage(n);
  const one = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: PAGE_SIDE / Math.max(one.width, one.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvas, viewport, background: 'white' }).promise;
  let text = '';
  try {
    const tc = await page.getTextContent();
    text = tc.items.map((i) => `${i.str}${i.hasEOL ? '\n' : ' '}`).join('').replace(/[ \t]+\n/g, '\n').trim().slice(0, TEXT_MAX);
  } catch { /* a scan has none */ }
  page.cleanup();
  return { image: await canvasJpeg(canvas), text };
}

/** A photo → { image }, turned the way the camera held it */
async function photoPage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
    throw new Error(/heic|heif/i.test(file.type + file.name) ? 'This browser can’t open HEIC photos. Save it as a JPG, or add it from an iPhone.' : `${file.name} isn’t a picture this browser can open.`);
  }
  const scale = Math.min(1, PAGE_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return { image: await canvasJpeg(canvas), text: '' };
}

// ─── Uploads, running outside the components ──────────────────────────

const runs = [];
const subs = new Set();
const changed = () => subs.forEach((f) => f([...runs]));
function useRuns() {
  const [list, setList] = useState([...runs]);
  useEffect(() => { subs.add(setList); return () => subs.delete(setList); }, []);
  return list;
}

/**
 * Files chosen or dropped → uploads: each PDF on its own; photos chosen together
 * as one (one page each). opts: { year, account?, scorer?, onSummaries, onDone, addToast }
 */
export function addFiles(fileList, opts) {
  const files = [...(fileList || [])];
  const pdfs = files.filter(isPdf);
  const photos = files.filter((f) => !isPdf(f) && isImage(f));
  const other = files.filter((f) => !isPdf(f) && !isImage(f));
  if (other.length) opts.addToast?.(`${andList(other.map((f) => f.name))} ${other.length === 1 ? 'isn’t' : 'aren’t'} a PDF or a photo, so ${other.length === 1 ? 'it was' : 'they were'} left out.`, 'warning');
  for (const f of pdfs) startRun({ name: f.name, files: [f], kind: 'pdf' }, opts);
  if (photos.length) usablePhotos(photos, opts).then((ok) => {
    if (ok.length) startRun({ name: ok.length === 1 ? ok[0].name : `${ok.length} photos`, files: ok, kind: 'photos' }, opts);
  });
}

/** The photos this browser can open; the rest are named and left out, so one bad one doesn't hold up the others */
async function usablePhotos(photos, opts) {
  const ok = [];
  const bad = [];
  for (const f of photos) {
    try { const b = await createImageBitmap(f); b.close?.(); ok.push(f); } catch { bad.push(f); }
  }
  if (bad.length) {
    const heic = bad.some((f) => /heic|heif/i.test(f.type + f.name));
    opts.addToast?.(`${andList(bad.map((f) => f.name))} couldn’t be opened, so ${bad.length === 1 ? 'it was' : 'they were'} left out${heic ? '. Save HEIC photos as JPG, or add them from an iPhone' : ''}.`, 'warning');
  }
  return ok;
}

function startRun(src, opts) {
  const r = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: src.name, year: opts.year, state: 'starting', page: 0, pages: 0, read: 0,
    counts: { saved: 0, same: 0, check: 0, empty: 0, elsewhere: 0 }, error: null, scan: null, hash: null, stop: false, src, opts };
  runs.unshift(r);
  changed();
  go(r);
}

async function go(r, { resume = null, again = false } = {}) {
  const { src, opts } = r;
  r.state = 'starting'; r.error = null; r.stop = false;
  changed();
  try {
    let doc = null;
    let hash;
    if (src.kind === 'pdf') {
      const buf = await src.files[0].arrayBuffer();
      hash = await sha256(buf);
      try { doc = await openPdf(buf); } catch (e) {
        throw new Error(/password/i.test(e?.message || e?.name || '') ? `${r.name} is locked with a password.` : `${r.name} couldn’t be opened as a PDF.`);
      }
      r.pages = doc.numPages;
    } else {
      const parts = await Promise.all(src.files.map(async (f) => sha256(await f.arrayBuffer())));
      hash = await sha256(new TextEncoder().encode([...parts].sort().join(':')));
      r.pages = src.files.length;
    }
    r.hash = hash;
    // The same file twice at once (two drops, or a second tab): one reading is enough
    if (runs.some((x) => x !== r && x.hash === hash && (x.state === 'reading' || x.state === 'starting'))) {
      opts.addToast?.(`${r.name} is being read already.`, 'info');
      return cancel(r);
    }
    const start = { year: r.year, name: r.name, hash, pages: r.pages, account: opts.account || null, scorer: opts.scorer || null, again, resume };
    let j = await call(API, { start });
    if (j.success && j.duplicate) {
      const d = j.duplicate;
      const when = new Date(d.at).toLocaleDateString([], { month: 'short', day: 'numeric' });
      if (d.reading) {
        opts.addToast?.(`${d.name} is being read right now. It shows here when it’s done.`, 'info');
        return cancel(r);
      }
      if (d.read < d.pages) {
        if (!(await ask({ title: 'Pick up where it stopped?', text: `${d.name} was added on ${when} and stopped after ${plural(d.read, 'page')} of ${d.pages}. The rest are read now; the pages already read stay as they are.`, yes: 'Pick it up' }))) return cancel(r);
        j = await call(API, { start: { resume: d.id } });
      } else {
        if (!(await ask({ title: 'Read it again?', text: `${d.name} was added on ${when}. Reading it again saves nothing it already saved twice: a sheet that says the same changes nothing, and one that differs waits for a person.`, yes: 'Read again' }))) return cancel(r);
        j = await call(API, { start: { ...start, again: true } });
      }
    }
    if (!j.success) throw new Error(j.error || 'Couldn’t start reading it');
    r.scan = j.scan.id;
    const done = new Set(j.scan.done || []);
    r.read = done.size;
    r.state = 'reading';
    for (let n = 1; n <= r.pages; n++) {
      if (r.stop) { r.state = 'stopped'; changed(); doc?.destroy?.(); opts.onDone?.(r); return; }
      r.page = n;
      changed();
      if (done.has(n)) continue;
      const pg = doc ? await pdfPage(doc, n) : await photoPage(src.files[n - 1]);
      let out = null;
      for (let t = 0; t < RETRIES && !out; t++) {
        const res = await call(API, { page: { scan: r.scan, page: n, image: pg.image, text: pg.text } });
        if (res.success) out = res;
        else if (res.status === 409 && /undone/i.test(res.error || '')) { r.undone = true; throw new Error('That upload was undone while it was being read.'); }
        else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new Error(res.error || `Page ${n} couldn’t be read`);
        else await new Promise((w) => setTimeout(w, 2000 * (t + 1)));
      }
      if (!out) throw new Error(`Page ${n} couldn’t be sent. Check the connection, then pick it up again.`);
      // Being read already (an answer that got lost on the way back, or another tab): wait for that reading's answer
      for (let waited = 0; out.busy && waited < BUSY_WAIT_MS && !r.stop; waited += 5000) {
        r.waiting = true; changed();
        await new Promise((w) => setTimeout(w, 5000));
        const res = await call(API, { page: { scan: r.scan, page: n, image: pg.image, text: pg.text } });
        if (res.success) out = res;
      }
      r.waiting = false;
      if (out.busy) throw new Error(`Page ${n} is still being read somewhere else. Pick it up again in a few minutes.`);
      r.read++;
      for (const it of out.items) {
        if (it.status === 'saved') r.counts.saved++;
        else if (it.status === 'same') r.counts.same++;
        else if (it.status === 'check' || it.status === 'failed') r.counts.check++;
        else if (it.status === 'empty') r.counts.empty++;
      }
      if (Object.keys(out.summaries || {}).length) opts.onSummaries?.(out.summaries);
    }
    doc?.destroy?.();
    r.state = 'done';
    changed();
    const c = r.counts;
    opts.addToast?.(`${r.name}: ${[c.saved && `${plural(c.saved, 'scorecard')} saved`, c.same && `${c.same} already there`, c.check && `${c.check} to check`].filter(Boolean).join(', ') || 'no scoresheets found'}.`, c.check ? 'info' : 'success');
    opts.onDone?.(r);
  } catch (e) {
    r.state = 'failed';
    r.error = e?.message || String(e);
    changed();
    opts.onDone?.(r);
  }
}
function cancel(r) {
  const i = runs.indexOf(r);
  if (i >= 0) runs.splice(i, 1);
  changed();
}

function RunRow({ r }) {
  const pct = r.pages ? Math.round((r.read / r.pages) * 100) : 0;
  const c = r.counts;
  const tally = [c.saved && `${c.saved} saved`, c.same && `${c.same} already there`, c.check && `${c.check} to check`, c.empty && `${plural(c.empty, 'page')} with no scores`].filter(Boolean).join(' · ');
  const line = r.state === 'starting' ? 'Opening it…'
    : r.state === 'reading' ? (r.stop ? `Stopping after page ${r.page}…` : r.waiting ? `Page ${r.page} is being read already; waiting for it…` : `Reading page ${r.page} of ${r.pages}…`)
      : r.state === 'done' ? `Read all ${plural(r.pages, 'page')}`
        : r.state === 'stopped' ? `Stopped: ${r.read} of ${plural(r.pages, 'page')} read`
          : r.error;
  return html`<li class=${`ssc-run is-${r.state}`}>
    <div class="ssc-run-top"><b>${r.name}</b><span class="ssc-run-line" aria-live="polite">${line}</span>
      ${r.state === 'reading' && !r.stop && html`<button class="apl-more" onClick=${() => { r.stop = true; changed(); }}>Stop</button>`}
      ${(r.state === 'failed' || r.state === 'stopped') && r.scan && !r.undone && html`<button class="apl-more" onClick=${() => go(r, { resume: r.scan })}>Pick it up</button>`}
      ${(r.state === 'done' || r.state === 'failed' || r.state === 'stopped') && html`<button class="apl-more" onClick=${() => cancel(r)} aria-label=${`Clear ${r.name} from this list`}>Clear</button>`}
    </div>
    ${(r.state === 'reading' || r.state === 'starting') && html`<div class="kd-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct} aria-label=${`Reading ${r.name}`}><span style=${`width:${pct}%`}></span></div>`}
    ${tally && html`<div class="ssc-line">${tally}</div>`}
  </li>`;
}

// ─── Choosing files ───────────────────────────────────────────────────

const touch = () => window.matchMedia?.('(pointer: coarse)').matches;

/** "Add scoresheets" (and, on a phone, "Take photos"): files go straight to the reader */
function AddButtons({ onFiles, label = 'Add scoresheets', small = false }) {
  const files = useRef(null);
  const camera = useRef(null);
  const pick = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) onFiles(f); };
  return html`<span class="ssc-add">
    <button class=${`btn btn-primary${small ? ' btn-sm' : ''}`} onClick=${() => files.current.click()}>${label}</button>
    ${touch() && html`<button class=${`btn btn-ghost${small ? ' btn-sm' : ''}`} onClick=${() => camera.current.click()}>Take photos</button>`}
    <input ref=${files} type="file" accept="application/pdf,.pdf,image/*" multiple hidden onChange=${pick} />
    <input ref=${camera} type="file" accept="image/*" capture="environment" multiple hidden onChange=${pick} />
  </span>`;
}

// ─── The Scores view's part ───────────────────────────────────────────

/**
 * Add scoresheets, what's being read, what waits under Check these, the
 * season's uploads, and Print scoresheets.
 * props: { year, me, onSummaries, onChanged, addToast }
 */
export function ScanBar({ year, me, onSummaries, onChanged, addToast }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [scorer, setScorer] = useState('');
  const [checking, setChecking] = useState(null); // index into d.waiting
  const [history, setHistory] = useState(false);
  const [dragging, setDragging] = useState(false);
  const all = useRuns();
  const mine = all.filter((r) => r.year === year && !r.opts.account);
  const finished = useRef(new Set());
  const load = useCallback(async () => {
    if (!year) return;
    const j = await call(`${API}?year=${encodeURIComponent(year)}`);
    if (!j.success) { setErr(j.error || 'Couldn’t load the scoresheets'); return; }
    setErr(null);
    setD(j);
  }, [year]);
  useEffect(() => { setD(null); load(); }, [load]);
  // An upload of this season finishing anywhere (a family's Score tab too): what's waiting and what's been added catch up
  useEffect(() => {
    let again = false;
    for (const r of all) {
      if (r.year !== year || !/done|failed|stopped/.test(r.state) || finished.current.has(r.id)) continue;
      finished.current.add(r.id);
      again = true;
    }
    if (again) load();
  }, [all, year]);
  const add = (files) => {
    if (!year) { addToast('Pick a season first: scoresheets are read into one season’s families.', 'warning'); return; }
    addFiles(files, { year, scorer: scorer || null, addToast, onSummaries, onDone: () => onChanged?.() });
  };
  const addRef = useRef(add);
  addRef.current = add;
  // Drop PDFs or photos anywhere on the Scores view
  useEffect(() => {
    let depth = 0;
    const has = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const enter = (e) => { if (!has(e)) return; depth++; setDragging(true); };
    const leave = (e) => { if (!has(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const over = (e) => { if (has(e)) e.preventDefault(); };
    const drop = (e) => { if (!has(e)) return; e.preventDefault(); depth = 0; setDragging(false); addRef.current(e.dataTransfer.files); };
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave); window.addEventListener('dragover', over); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, []);
  useStyles();

  const waiting = d?.waiting || [];
  const scans = d?.scans || [];
  return html`<section class="apl-panel ssc" aria-label="Scoresheets">
    <div class="ssc-head">
      <div class="ssc-title"><h3>Scoresheets</h3><p class="ssc-sub">${touch() ? 'Add a PDF or take photos of paper scoresheets.' : 'Add a PDF or photos of scoresheets, or drop them anywhere here.'} Each is read into its scorer’s card; anything unsure waits for you.</p></div>
      <div class="ssc-actions">
        <label class="ssc-who"><span class="sr-only">Whose scores</span>
          <select class="form-select" value=${scorer} onChange=${(e) => setScorer(e.target.value)} aria-label="Whose scores are in the files">
            <option value="">Scorer: as written on each sheet</option>
            ${(d?.scorers || []).filter((p) => p.name).sort((a, b) => a.name.localeCompare(b.name)).map((p) => html`<option key=${p.email} value=${p.email}>All ${firstName(p)}’s</option>`)}
          </select>
        </label>
        <${AddButtons} onFiles=${add} />
        <button class="btn btn-ghost" onClick=${() => printSheets({ year, families: printable(d?.families) })} disabled=${!d}>Print scoresheets</button>
      </div>
    </div>
    ${err && html`<div class="apl-callout is-warn">${err} <button class="apl-more" onClick=${load}>Try again</button></div>`}
    ${mine.length > 0 && html`<ul class="ssc-runs">${mine.map((r) => html`<${RunRow} key=${r.id} r=${r} />`)}</ul>`}
    ${waiting.length > 0 && html`<div class="ssc-waiting">
      <div><b>${plural(waiting.length, 'sheet')} to check</b><span class="ssc-line">${waitLine(waiting)}</span></div>
      <button class="btn btn-primary btn-sm" onClick=${() => setChecking(0)}>Check ${waiting.length === 1 ? 'it' : 'them'}</button>
    </div>`}
    ${scans.length > 0 && html`<div class="ssc-history">
      <button class="apl-more" aria-expanded=${history} onClick=${() => setHistory(!history)}>${history ? 'Hide' : 'Show'} what’s been added (${scans.length})</button>
      ${history && html`<${Uploads} d=${d} reload=${load} onSummaries=${onSummaries} onChanged=${onChanged} addToast=${addToast} />`}
    </div>`}
    ${dragging && html`<div class="ssc-drop" aria-hidden="true"><div><b>Drop to read these scoresheets</b><span>Into the ${year} families</span></div></div>`}
    ${checking != null && d && html`<${CheckDialog} d=${d} start=${checking} me=${me} onSummaries=${onSummaries}
      onClose=${() => { setChecking(null); load(); onChanged?.(); }} addToast=${addToast} />`}
  </section>`;
}

/** The season's families to print sheets for (all of them, whatever the board is filtered to): not turned down, by name */
function printable(families) {
  return (families || []).filter((f) => f.status !== 'Denied' && !/^\s*test\b/i.test(f.name)).map((f) => ({ id: f.id, name: f.name, code: f.code, rubric: f.rubric })).sort((x, y) => x.name.localeCompare(y.name));
}

const PROBLEM = {
  family: 'which family', scorer: 'who scored it', 'new-scorer': 'a first-time scorer', disagree: 'the two readings differ', unread: 'a score couldn’t be read',
  rubric: 'it’s on the other season’s criteria', total: 'the written total doesn’t add up', alone: 'only one reading', 'has-card': 'they already have scores',
  twice: 'two sheets for one family', failed: 'it couldn’t be read', 'taken-off': 'taken off to fix', undone: 'its upload was undone',
};
function waitLine(items) {
  const n = {};
  for (const it of items) for (const p of it.problems) n[p] = (n[p] || 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, c]) => `${c} ${PROBLEM[p] || p}`).join(' · ');
}

// ─── Uploads and what each saved ──────────────────────────────────────

function Uploads({ d, reload, onSummaries, onChanged, addToast }) {
  const [open, setOpen] = useState(null);
  const people = new Map((d.scorers || []).map((p) => [p.email, p]));
  const fams = new Map((d.families || []).map((f) => [f.id, f.name]));
  const putBack = async (it) => {
    const j = await call(API, { unskip: { scan: it.scan, page: it.page, idx: it.idx } });
    if (!j.success) { addToast(j.error || 'Not changed', 'error'); return; }
    addToast('Back under Check these.', 'success');
    reload();
  };
  const undo = async (s) => {
    const n = s.counts.saved;
    if (!(await ask({ title: `Undo ${s.name}?`, text: `${n ? `The ${plural(n, 'scorecard')} it saved ${n === 1 ? 'is' : 'are'} taken off, and any card it replaced comes back.` : 'Nothing it read was saved.'} A card someone has changed since stays as it is.`, yes: 'Undo it', danger: true }))) return;
    const j = await call(API, { undo: { scan: s.id } });
    if (!j.success) { addToast(j.error || 'Not undone', 'error'); return; }
    if (Object.keys(j.summaries || {}).length) onSummaries?.(j.summaries);
    addToast(`${s.name} undone${j.changed ? `; ${plural(j.changed, 'card')} changed since ${j.changed === 1 ? 'was' : 'were'} left as ${j.changed === 1 ? 'it is' : 'they are'}` : ''}.`, 'success');
    reload(); onChanged?.();
  };
  const takeOff = async (it) => {
    const j = await call(API, { unsave: { scan: it.scan, page: it.page, idx: it.idx } });
    if (!j.success) { addToast(j.error || 'Not taken off', 'error'); return; }
    onSummaries?.({ [it.account]: j.summary });
    addToast(j.kept ? 'Taken off. Another upload has the very same scores, so the card stays, as that upload’s.' : 'Taken off. It waits under Check these.', 'success');
    reload(); onChanged?.();
  };
  return html`<ul class="ssc-uploads">${d.scans.map((s) => {
    const items = (d.saved || []).filter((it) => it.scan === s.id);
    const leftOut = (d.left || []).filter((it) => it.scan === s.id);
    const c = s.counts;
    return html`<li key=${s.id} class=${s.undoneAt ? 'is-undone' : ''}>
      <div class="ssc-upload-top">
        <div><b>${s.name}</b><span class="ssc-line">${[firstName(people.get(s.by) || { email: s.by }), ago(s.at), plural(s.pages, 'page'),
          s.undoneAt ? `undone ${ago(s.undoneAt)}` : [c.saved && `${c.saved} saved`, c.same && `${c.same} already there`, c.check && `${c.check} to check`, c.skipped && `${c.skipped} left out`, s.read < s.pages && `${s.pages - s.read} not read yet`].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span></div>
        ${!s.undoneAt && items.length + leftOut.length > 0 && html`<button class="apl-more" aria-expanded=${open === s.id} onClick=${() => setOpen(open === s.id ? null : s.id)}>${open === s.id ? 'Hide' : 'See'} what it saved</button>`}
        ${!s.undoneAt && html`<button class="apl-more" onClick=${() => undo(s)}>Undo</button>`}
      </div>
      ${open === s.id && html`<ul class="ssc-saved">${items.map((it) => html`<li key=${`${it.page}-${it.idx}`}>
        <span><b>${fams.get(it.account) || it.familyText}</b> · ${firstName(people.get(it.evaluator) || { email: it.evaluator })} · ${totalOf(it.scores, it.rubric) ?? `${Object.keys(it.scores).length} of 10`}${it.status === 'same' ? ' · already there' : ''}${Object.keys(it.held || {}).length && !it.heldAt ? ' · readiness after the visit' : ''}</span>
        <a class="apl-more" href=${imageUrl(it.scan, it.page)} target="_blank" rel="noopener">Page ${it.page}</a>
        ${it.status === 'saved' && html`<button class="apl-more" onClick=${() => takeOff(it)}>Take off</button>`}
      </li>`)}${leftOut.map((it) => html`<li key=${`l${it.page}-${it.idx}`}>
        <span><b>${fams.get(it.account) || it.familyText || 'A sheet'}</b> · left out</span>
        <a class="apl-more" href=${imageUrl(it.scan, it.page)} target="_blank" rel="noopener">Page ${it.page}</a>
        <button class="apl-more" onClick=${() => putBack(it)}>Put it back</button>
      </li>`)}</ul>`}
    </li>`;
  })}</ul>`;
}

// ─── Check these ──────────────────────────────────────────────────────

/** Why a sheet waits, in plain words */
function reasons(it, people, fams) {
  const gone = it.account && !fams.has(it.account) ? [`The family it was matched to${it.familyText ? ` (“${it.familyText}”)` : ''} isn’t one of the ${it.year} families any more (archived, or moved to another season). Pick the family, or leave it out.`] : [];
  const crit = (k) => criteriaOf(it.rubric).find((c) => c.key === k) || criteriaOf(rubricOfSeason(it.year)).find((c) => c.key === k) || { label: k };
  const out = [];
  for (const p of it.problems) {
    if (p === 'disagree') {
      const ds = it.disagree.filter((x) => keysOf(it.rubric).includes(x.key));
      out.push(`The two readings differ on ${andList(ds.map((x) => `${crit(x.key).label} (${[...new Set(Object.values(x.values).map((v) => v ?? 'blank'))].join(' or ')})`))}.`);
    } else if (p === 'unread') {
      const ks = keysOf(it.rubric).filter((k) => it.scores[k] == null && !it.disagree.some((x) => x.key === k));
      if (ks.length) out.push(`${andList(ks.map((k) => crit(k).label))} couldn’t be read.`);
    } else if (p === 'family') {
      const read = [...new Set(Object.values(it.seen || {}).filter(Boolean).map((x) => x.family).filter(Boolean))];
      out.push(read.length > 1 ? `The two readings name different families: ${andList(read.map((x) => `“${x}”`))}.`
        : it.familyText ? `“${it.familyText}” isn’t clearly one ${it.year} family.${it.candidates.length ? ` Closest: ${andList(it.candidates.slice(0, 3).map((c) => c.name))}.` : ''}` : 'The sheet doesn’t say which family.');
    } else if (p === 'scorer') {
      const read = [...new Set(Object.values(it.seen || {}).filter(Boolean).map((x) => x.scorer).filter(Boolean))];
      out.push(read.length > 1 ? `The two readings name different scorers: ${andList(read.map((x) => `“${x}”`))}.`
        : it.scorerText ? `“${it.scorerText}” isn’t clearly one of SOARD’s people${it.evaluator ? '' : ', or isn’t who the upload said'}.` : 'The sheet doesn’t say who scored it.');
    }
    else if (p === 'undone') out.push('Its upload was undone while it was being read.');
    else if (p === 'new-scorer') out.push(`${people.get(it.evaluator)?.name || it.evaluator} hasn’t scored before. Is it theirs?`);
    else if (p === 'total') {
      const totals = [...new Set(Object.values(it.seen || {}).filter(Boolean).map((x) => x.total).filter((t) => t != null))];
      out.push(totals.length > 1 ? `The two readings saw different written totals (${andList(totals.map(String))}).` : `The total written on it${it.total != null ? ` (${it.total})` : ''} isn’t what the scores add up to.`);
    }
    else if (p === 'rubric') out.push('Its criteria aren’t the ones this family is scored on (Mission & story and Financial need are each only on one season’s sheet). Enter the scores the family’s criteria need.');
    else if (p === 'alone') out.push('Only one of the two readers read it.');
    else if (p === 'failed') out.push('Neither reader could read this page.');
    else if (p === 'has-card') out.push(`${firstName(people.get(it.evaluator) || { email: it.evaluator })} already has scores for ${fams.get(it.account) || 'this family'}${it.theirs?.total != null ? ` (${it.theirs.total})` : ''}, and this sheet says something else.`);
    else if (p === 'twice') out.push('Another sheet in this upload gave their scores for this family already, and says something else.');
    else if (p === 'taken-off') out.push('It was taken off to be fixed.');
  }
  return [...gone, ...out];
}

function CheckDialog({ d, start = 0, me, onSummaries, onClose, addToast }) {
  // The sheets as they were when it opened: an upload finishing meanwhile never changes the one in front of you
  const [items] = useState(() => [...d.waiting].sort((a, b) => String(a.scanAt).localeCompare(String(b.scanAt)) || a.scan.localeCompare(b.scan) || a.page - b.page || a.idx - b.idx));
  const [i, setI] = useState(Math.max(0, Math.min(start, items.length - 1)));
  const [left, setLeft] = useState(() => items.map(() => true));
  const [tally, setTally] = useState({ saved: 0, out: 0, read: 0 });
  const people = useMemo(() => new Map((d.scorers || []).map((p) => [p.email, p])), [d]);
  const fams = useMemo(() => new Map((d.families || []).map((f) => [f.id, f])), [d]);
  const it = items[i];
  const [form, setForm] = useState(null);
  const [row, setRow] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [peek, setPeek] = useState(false);
  const [other, setOther] = useState('');
  const dialog = useRef(null);
  // The rubric of the family picked (a family scored in 2026 keeps 2026's), else what the sheet was read on
  const rubricNow = (form && fams.get(form.account)?.rubric) || it?.rubric;
  const crits = it ? criteriaOf(rubricNow) : [];
  useEffect(() => {
    if (!it) return;
    const keys = keysOf(it.rubric);
    // Only what was matched exactly is filled in: two close matches are a person's pick
    setForm({ account: it.account || '', evaluator: it.evaluator || '', scores: Object.fromEntries(keys.map((k) => [k, it.scores[k] ?? null])) });
    const flagged = keys.findIndex((k) => it.scores[k] == null);
    setRow(flagged >= 0 ? flagged : 0);
    setZoom(false); setPeek(false); setOther('');
  }, [i]);
  const fam = form ? fams.get(form.account) : null;
  // Scored after the home visit (from 2027): can stay blank until the family has had it
  const later = new Set(fam && !fam.visited ? crits.filter((c) => c.after === 'visit').map((c) => c.key) : []);
  const remaining = left.filter(Boolean).length;
  const nextOpen = (from, l = left) => {
    for (let k = 1; k <= items.length; k++) { const j = (from + k) % items.length; if (l[j] && j !== from) return j; }
    return null;
  };
  const advance = (doneIdx, how) => {
    const l = left.map((v, j) => (j === doneIdx ? false : v));
    const t = { ...tally, [how]: tally[how] + 1 };
    setLeft(l);
    setTally(t);
    const n = l[doneIdx] === false && !l.some(Boolean) ? null : nextOpen(doneIdx, l);
    if (n == null) {
      addToast(`Done: ${[t.saved && `${plural(t.saved, 'scorecard')} saved`, t.read && `${plural(t.read, 'page')} read again`, t.out && `${t.out} left out`].filter(Boolean).join(', ') || 'nothing changed'}.`, 'success');
      onClose();
    } else setI(n);
  };
  const set = (k, v) => {
    setForm((f) => ({ ...f, scores: { ...f.scores, [k]: v } }));
    const keys = crits.map((c) => c.key);
    const at = keys.indexOf(k);
    const nextBlank = keys.findIndex((x, j) => j > at && form.scores[x] == null && !later.has(x));
    setRow(nextBlank >= 0 ? nextBlank : Math.min(at + 1, keys.length - 1));
  };
  const evaluatorKnown = form && people.has(form.evaluator);
  const meMain = d.me || me;
  // Score on your own first: someone else's sheet for a family you haven't scored stays covered until you say
  // (whatever the board is filtered to: the server says which families you've scored)
  const cover = !!(form && !peek && meMain && evaluatorKnown && form.evaluator !== meMain && fam && !fam.mine);
  const save = async (override = false) => {
    if (!form || busy || cover) return;
    const missing = crits.filter((c) => form.scores[c.key] == null && !later.has(c.key));
    if (!form.account) { addToast('Pick the family first.', 'warning'); return; }
    if (missing.length) { addToast(`Give ${missing[0].label} a score first.`, 'warning'); setRow(crits.indexOf(missing[0])); return; }
    const evaluator = form.evaluator === '__other' ? other.trim().toLowerCase() : form.evaluator;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(evaluator)) { addToast('Pick who scored it.', 'warning'); return; }
    setBusy(true);
    const j = await call(API, { confirm: { scan: it.scan, page: it.page, idx: it.idx, account: form.account, evaluator, scores: form.scores, override } });
    setBusy(false);
    if (!j.success) {
      if (j.code === 'has-card' || j.code === 'twice') {
        if (await ask({ title: 'Use this sheet’s scores?', text: `${firstName(people.get(evaluator) || { email: evaluator })} already has scores for ${fam?.name || 'this family'}${j.card?.total != null ? ` (${j.card.total})` : ''}. This sheet’s replace them; Undo puts theirs back.`, yes: 'Use this sheet’s' })) save(true);
        return;
      }
      addToast(j.error || 'Not saved', 'error');
      return;
    }
    onSummaries?.({ [form.account]: j.summary });
    advance(i, 'saved');
  };
  // A page neither reader could read (a timeout, say): read again from the picture the site kept
  const reread = async () => {
    if (busy) return;
    setBusy(true);
    const j = await call(API, { page: { scan: it.scan, page: it.page, again: true } });
    setBusy(false);
    if (!j.success) { addToast(j.error || 'Not read', 'error'); return; }
    if (Object.keys(j.summaries || {}).length) onSummaries?.(j.summaries);
    const c = (j.items || []).reduce((n, x) => ({ ...n, [x.status]: (n[x.status] || 0) + 1 }), {});
    addToast(c.failed ? 'Still couldn’t be read. Enter the scores from the page, or leave it out.' : `Read: ${[c.saved && `${c.saved} saved`, c.same && `${c.same} already there`, c.check && `${c.check} to check`, c.empty && 'no scores on it'].filter(Boolean).join(', ')}.`, c.failed ? 'warning' : 'success');
    if (!c.failed) advance(i, 'read');
  };
  const skip = async () => {
    if (busy) return;
    setBusy(true);
    const j = await call(API, { skip: { scan: it.scan, page: it.page, idx: it.idx } });
    setBusy(false);
    if (!j.success) { addToast(j.error || 'Not changed', 'error'); return; }
    advance(i, 'out');
  };
  // Keys: 1 to 5 score the row the focus is in (or the marked row); ↑↓ move between rows, ←→ change a row's score;
  // Enter saves, unless the focus is on a button, which Enter presses. Tab stays inside the dialog.
  const keyRef = useRef(null);
  keyRef.current = { set, save, row, crits, setRow, cover, form };
  useEffect(() => {
    const onKey = (e) => {
      // A question asked from here (ask.js) answers its own keys
      if (document.querySelector('.ask-overlay')) return;
      const k = keyRef.current;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === 'Tab') {
        const f = [...(dialog.current?.querySelectorAll('button:not([disabled]), select, input, a[href], [tabindex="0"]') || [])].filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        const at = f.indexOf(document.activeElement);
        if (e.shiftKey && at <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (at === -1 || at === f.length - 1)) { e.preventDefault(); f[0].focus(); }
        return;
      }
      const el = document.activeElement;
      const t = el?.tagName || '';
      if (/INPUT|TEXTAREA|SELECT/.test(t) || e.metaKey || e.ctrlKey || e.altKey || k.cover || !k.form) return;
      const inRow = el?.closest?.('.ssc-row');
      const r = inRow ? Number(inRow.dataset.row) : k.row;
      const key = k.crits[r]?.key;
      if (/^[1-5]$/.test(e.key) && key) { e.preventDefault(); if (r !== k.row) k.setRow(r); k.set(key, Number(e.key)); if (inRow) requestAnimationFrame(() => dialog.current?.querySelector(`.ssc-row[data-row="${keyRef.current.row}"] [tabindex="0"]`)?.focus()); }
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && inRow && key) {
        e.preventDefault();
        const v = Math.min(5, Math.max(1, (k.form.scores[key] || (e.key === 'ArrowRight' ? 0 : 6)) + (e.key === 'ArrowRight' ? 1 : -1)));
        setForm((f) => ({ ...f, scores: { ...f.scores, [key]: v } }));
        requestAnimationFrame(() => inRow.querySelector(`[data-n="${v}"]`)?.focus());
      }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const to = e.key === 'ArrowDown' ? Math.min(r + 1, k.crits.length - 1) : Math.max(r - 1, 0);
        k.setRow(to);
        if (inRow) requestAnimationFrame(() => dialog.current?.querySelector(`.ssc-row[data-row="${to}"] [tabindex="0"]`)?.focus());
      }
      else if (e.key === 'Enter' && t !== 'BUTTON' && t !== 'A') { e.preventDefault(); k.save(); }
    };
    window.addEventListener('keydown', onKey, true);
    document.body.classList.add('modal-open');
    const opener = document.activeElement;
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (!document.querySelector('.modal-overlay:not(.ssc-overlay)')) document.body.classList.remove('modal-open');
      if (opener?.isConnected) opener.focus?.();
    };
  }, []);
  // Into the dialog once the sheet is on it (and on to each next sheet), unless something in it has the focus already
  useEffect(() => { if (form && !dialog.current?.contains(document.activeElement)) dialog.current?.focus(); }, [!!form, i]);
  if (!it || !form) return null;
  const sum = totalOf(form.scores, rubricNow);
  const so = crits.reduce((n, c) => n + (form.scores[c.key] || 0), 0);
  const why = reasons(it, people, new Map([...fams].map(([id, f]) => [id, f.name])));
  const disagree = new Map(it.disagree.map((x) => [x.key, [...new Set(Object.values(x.values).filter((v) => v != null))]]));
  const candidates = it.candidates.map((c) => c.id);
  const famOptions = [...(d.families || [])].sort((a, b) => (candidates.includes(b.id) - candidates.includes(a.id)) || a.name.localeCompare(b.name));
  const scorerOptions = [...(d.scorers || [])].filter((p) => p.name || p.email).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  const blanks = crits.filter((c) => form.scores[c.key] == null && !later.has(c.key)).length;
  return html`<div class="modal-overlay kd-overlay ssc-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal kd-dialog kd-dialog--xl ssc-check" role="dialog" aria-modal="true" aria-labelledby="ssc-check-title" tabindex="-1" ref=${dialog}>
      <header class="kd-dialog__head">
        <div class="kd-dialog__titles"><h2 id="ssc-check-title">Check this sheet</h2>
          <p class="kd-dialog__sub apl-card-sub ssc-check-sub">${it.file} · page ${it.page}${it.idx ? `, sheet ${it.idx + 1}` : ''} · ${remaining} to check</p></div>
        <button class="kd-x" onClick=${onClose} aria-label="Close"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
      </header>
      <div class="kd-dialog__body ssc-check-body">
        ${cover ? html`<div class="ssc-page ssc-page-hidden"><p>The page is hidden: it shows ${firstName(people.get(form.evaluator))}’s scores.</p></div>` : html`<figure class=${`ssc-page${zoom ? ' is-zoom' : ''}`}>
          <button class="ssc-page-img" onClick=${() => setZoom(!zoom)} aria-label=${zoom ? 'Fit the page' : 'Zoom in on the page'}><img src=${imageUrl(it.scan, it.page)} alt=${`Page ${it.page} of ${it.file}`} /></button>
          <figcaption class="apl-card-sub">${zoom ? 'Click to fit' : 'Click to zoom'} · <a href=${imageUrl(it.scan, it.page)} target="_blank" rel="noopener">Open the page</a></figcaption>
        </figure>`}
        <div class="ssc-form">
          <div class="apl-callout is-warn ssc-why"><b>Why it waits</b><ul>${cover ? html`<li>${firstName(people.get(form.evaluator))}’s sheet needs a person to check it.</li>` : why.map((w, k) => html`<li key=${k}>${w}</li>`)}</ul></div>
          <div class="ssc-who-row">
            <label>Family
              <select class="form-select" value=${form.account} onChange=${(e) => {
                // On another rubric, the criteria both have keep their scores
                const r = fams.get(e.target.value)?.rubric || it.rubric;
                setForm({ ...form, account: e.target.value, scores: Object.fromEntries(keysOf(r).map((k) => [k, form.scores[k] ?? it.scores[k] ?? null])) });
              }}>
                <option value="">Pick the family</option>
                ${famOptions.map((f) => html`<option key=${f.id} value=${f.id}>${f.name}${!it.account && candidates.includes(f.id) ? ' (close match)' : ''}</option>`)}
              </select>
              ${it.familyText && html`<span class="apl-card-sub">Written: “${it.familyText}”</span>`}
            </label>
            <label>Scored by
              <select class="form-select" value=${form.evaluator} onChange=${(e) => setForm({ ...form, evaluator: e.target.value })}>
                <option value="">Pick who scored it</option>
                ${scorerOptions.map((p) => html`<option key=${p.email} value=${p.email}>${p.name || p.email}</option>`)}
                <option value="__other">Someone else…</option>
              </select>
              ${form.evaluator === '__other' && html`<input class="form-input" type="email" placeholder="Their email" value=${other} onInput=${(e) => setOther(e.target.value)} aria-label="Their email" />
                <span class="apl-card-sub">They’ll count as scoring ${it.year}: every family then waits on their scores too.</span>`}
              ${it.scorerText && html`<span class="apl-card-sub">Written: “${it.scorerText}”</span>`}
            </label>
          </div>
          ${cover ? html`<div class="ssc-cover">
            <p><b>You haven’t scored ${fam?.name} yet.</b> These are ${firstName(people.get(form.evaluator))}’s scores. Score on your own first, or check this one anyway.</p>
            <div><button class="btn btn-ghost btn-sm" onClick=${() => { setPeek(true); requestAnimationFrame(() => dialog.current?.querySelector(`.ssc-row[data-row="${row}"] [tabindex="0"]`)?.focus({ preventScroll: true })); }}>Check it anyway</button>${remaining > 1 && html`<button class="btn btn-ghost btn-sm" onClick=${() => { const n = nextOpen(i); if (n != null) setI(n); }}>Next sheet</button>`}</div>
          </div>` : html`<ol class="ssc-rows" role="list">
            ${crits.map((c, k) => {
              const v = form.scores[c.key];
              const seen = disagree.get(c.key);
              const flag = it.scores[c.key] == null && !later.has(c.key);
              const wait = later.has(c.key);
              return html`<li key=${c.key} data-row=${k} class=${`ssc-row${k === row ? ' is-row' : ''}${flag ? ' is-flag' : ''}`} onClick=${() => setRow(k)}>
                <span class="ssc-row-name"><b>${c.label}</b>${seen ? html`<small>Read as ${andList(seen.map(String))}</small>` : flag ? html`<small>Not read</small>` : wait ? html`<small class="is-quiet">After the home visit: can stay blank</small>` : null}</span>
                <span class="ssc-pick" role="radiogroup" aria-label=${c.label}>${[1, 2, 3, 4, 5].map((n) => html`<button key=${n} data-n=${n} role="radio" aria-checked=${v === n} tabindex=${v === n || (v == null && n === 1) ? 0 : -1}
                  class=${`apl-heat is-${n}${v === n ? ' is-on' : ''}`} title=${c.levels[n - 1]} onClick=${(e) => { e.stopPropagation(); setRow(k); set(c.key, v === n && wait ? null : n); }}>${n}</button>`)}</span>
              </li>`;
            })}
          </ol>`}
          ${!cover && html`<div class="ssc-total"><span>Total</span><b>${sum ?? so}</b><span class="apl-card-sub">${sum != null ? `of ${TOTAL_MAX}` : blanks ? `${blanks} still to give` : 'so far; readiness after the home visit'}${it.total != null ? ` · written on the sheet: ${it.total}${sum != null && sum !== it.total ? ' (different)' : ''}` : ''}</span></div>`}
          ${!cover && it.notes && html`<p class="apl-card-sub ssc-notes"><b>Their notes:</b> ${it.notes}</p>`}
          ${!cover && it.theirs && html`<p class="apl-card-sub">Their scores now: ${criteriaOf(it.theirs.rubric || it.rubric).map((c) => it.theirs.scores?.[c.key] ?? '–').join(' · ')}${it.theirs.total != null ? ` (total ${it.theirs.total})` : ''}.</p>`}
        </div>
      </div>
      <footer class="kd-dialog__foot">
        <span class="apl-card-sub ssc-keys">1 to 5 scores the marked row · Enter saves</span>
        ${it.status === 'failed' && html`<button class="btn btn-ghost" onClick=${reread} disabled=${busy}>Read it again</button>`}
        <button class="btn btn-ghost" onClick=${skip} disabled=${busy} title="It isn’t a scoresheet, it’s a copy, or SOARD isn’t scoring this family">Leave it out</button>
        ${remaining > 1 && html`<button class="btn btn-ghost" onClick=${() => { const n = nextOpen(i); if (n != null) setI(n); }} disabled=${busy}>Later</button>`}
        <button class="btn btn-primary" onClick=${() => save(false)} disabled=${busy || cover}>${busy ? 'Saving…' : html`<span class="ssc-long">Save their scorecard</span><span class="ssc-short">Save</span>`}</button>
      </footer>
    </div>
  </div>`;
}

// ─── A family's Score tab ─────────────────────────────────────────────

/** "Add a scanned sheet" for one family: read into that family's cards, and what waits checked right here */
export function ScanFamilyButton({ a, me = null, onSummaries, onDone, addToast }) {
  const all = useRuns();
  const [d, setD] = useState(null);
  const [cleared, setCleared] = useState(null); // the upload whose sheets are all checked
  useStyles();
  const r = all.find((x) => x.opts.account === a.id);
  if (!a.year) return html`<span class="apl-card-sub">Give ${a.name} a Makeover year to add a scanned sheet.</span>`;
  const check = async () => {
    const j = await call(`${API}?year=${encodeURIComponent(a.year)}`);
    if (!j.success) { addToast(j.error || 'Couldn’t load the sheets', 'error'); return; }
    const waiting = j.waiting.filter((it) => it.scan === r.scan);
    if (!waiting.length) { setCleared(r.scan); addToast('Nothing from it waits any more.', 'info'); return; }
    setD({ ...j, waiting });
  };
  return html`<div class="ssc-family">
    <${AddButtons} small label="Add a scanned sheet" onFiles=${(files) => addFiles(files, { year: String(a.year), account: a.id, addToast, onSummaries, onDone })} />
    ${r && html`<ul class="ssc-runs"><${RunRow} r=${r} /></ul>`}
    ${r?.state === 'done' && r.counts.check > 0 && cleared !== r.scan && html`<button class="btn btn-primary btn-sm" onClick=${check}>Check ${r.counts.check === 1 ? 'it' : 'them'}</button>`}
    ${d && html`<${CheckDialog} d=${d} me=${me} onSummaries=${onSummaries} addToast=${addToast} onClose=${async () => {
      setD(null);
      onDone?.();
      const j = await call(`${API}?year=${encodeURIComponent(a.year)}`);
      if (j.success && !j.waiting.some((it) => it.scan === r.scan)) setCleared(r.scan);
    }} />`}
  </div>`;
}

/** Where a scanned card came from: "Read from a scanned sheet · see the page" */
export function scanLink(card) {
  const [scan, page] = String(card?.ref || '').split(':');
  return card?.source === 'scan' && scan && page ? imageUrl(scan, Number(page)) : null;
}

// ─── Printable scoresheets ────────────────────────────────────────────

/**
 * SOARD's scoresheet, one page per family: its name and code at the top, the
 * scorer's name, each criterion with what 1 and 5 mean and five boxes, a total
 * and room for notes. The code is how a scan finds the family with nothing to guess.
 */
export function printSheets({ year, families = [] }) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const sheet = (f) => {
    // The family's own rubric (one scored in 2026 keeps 2026's); a blank sheet is the season's
    const crits = criteriaOf(f?.rubric || rubricOfSeason(year));
    return `<section class="ssp-page">
    <header class="ssp-head">
      <div><div class="ssp-org">Sunshine on a Ranney Day</div><h1>Makeover scoresheet</h1><div class="ssp-season">${esc(year)} season</div></div>
      <div class="ssp-ids"><div class="ssp-code">${esc(f?.code || '')}</div><div class="ssp-line"><span>Family</span><b>${esc(f?.name || '')}</b></div><div class="ssp-line"><span>Scored by</span><b></b></div></div>
    </header>
    <p class="ssp-how">Circle, check or fill in one box for each. 1 is the least, 5 the most. Score on your own; your scorecard is averaged with the others’.</p>
    <table class="ssp-table"><tbody>${crits.map((c, i) => `<tr>
      <th><span class="ssp-n">${i + 1}</span><b>${esc(c.label)}</b>${c.after === 'visit' ? ' <em>after the home visit</em>' : ''}<small>1: ${esc(c.levels[0])}<br>5: ${esc(c.levels[4])}</small></th>
      ${[1, 2, 3, 4, 5].map((n) => `<td><span class="ssp-box">${n}</span></td>`).join('')}
    </tr>`).join('')}
    <tr class="ssp-totalrow"><th><b>Total</b><small>Out of ${TOTAL_MAX}</small></th><td colspan="5"><span class="ssp-totalbox"></span></td></tr></tbody></table>
    <div class="ssp-notes"><b>Notes</b><span>What stood out, and why you scored it this way</span></div>
  </section>`;
  };
  const host = document.createElement('div');
  host.id = 'ssp-print';
  host.innerHTML = `<style>
    #ssp-print { display: none; }
    @media print {
      @page { size: letter; margin: 0.5in; }
      body > *:not(#ssp-print) { display: none !important; }
      #ssp-print { display: block; color: #000; font: 11pt/1.35 Helvetica, Arial, sans-serif; }
      .ssp-page { break-after: page; }
      .ssp-page:last-child { break-after: auto; }
      .ssp-head { display: flex; justify-content: space-between; gap: 0.3in; padding-bottom: 0.12in; border-bottom: 2px solid #000; }
      .ssp-org { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.08em; }
      .ssp-head h1 { margin: 0.02in 0; font-size: 18pt; }
      .ssp-season { font-size: 10pt; }
      .ssp-ids { min-width: 3.4in; }
      .ssp-code { font: 700 16pt/1 'Courier New', monospace; letter-spacing: 0.08em; text-align: right; }
      .ssp-line { display: flex; align-items: flex-end; gap: 0.1in; margin-top: 0.14in; }
      .ssp-line span { font-size: 9pt; white-space: nowrap; }
      .ssp-line b { flex: 1; min-height: 0.24in; border-bottom: 1px solid #000; font-size: 13pt; }
      .ssp-how { margin: 0.12in 0; font-size: 9.5pt; }
      .ssp-table { width: 100%; border-collapse: collapse; }
      .ssp-table th, .ssp-table td, .ssp-table small, .ssp-table em { text-transform: none; letter-spacing: normal; color: #000; background: none; }
      .ssp-table th { text-align: left; font-weight: 400; padding: 0.06in 0.08in 0.06in 0; border-top: 1px solid #999; }
      .ssp-table th b { font-size: 11pt; }
      .ssp-table th em { font-size: 8.5pt; }
      .ssp-table small { display: block; font-size: 7.5pt; line-height: 1.3; color: #333; }
      .ssp-n { display: inline-block; width: 0.22in; }
      .ssp-table td { width: 0.5in; text-align: center; border-top: 1px solid #999; }
      .ssp-box { display: inline-grid; place-items: center; width: 0.34in; height: 0.34in; border: 1.5px solid #000; border-radius: 3px; font: 700 13pt Helvetica, Arial, sans-serif; }
      .ssp-totalrow th, .ssp-totalrow td { border-top: 2px solid #000; }
      .ssp-totalbox { display: inline-block; width: 1.2in; height: 0.36in; border: 1.5px solid #000; }
      .ssp-notes { margin-top: 0.14in; height: 1.2in; padding: 0.06in 0.08in; border: 1px solid #999; }
      .ssp-notes span { margin-left: 0.08in; font-size: 8.5pt; color: #333; }
    }
  </style>${[...families, null].map(sheet).join('')}`;
  document.getElementById('ssp-print')?.remove();
  document.body.appendChild(host);
  const done = () => { host.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}

// ─── Styles ───────────────────────────────────────────────────────────

let styled = false;
function useStyles() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.id = 'ssc-style';
  el.textContent = `
.ssc { position: relative; display: grid; gap: .75rem; }
.ssc-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: .75rem 1.25rem; }
.ssc-title { display: grid; gap: .2rem; max-width: 46ch; }
.ssc-title h3 { margin: 0; }
.ssc-sub { margin: 0; font-size: var(--fs-xs); line-height: 1.45; color: var(--color-text-secondary); }
.ssc-short { display: none; }
.ssc-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.ssc-add { display: inline-flex; gap: .5rem; }
.ssc-who select { min-width: 13rem; }
.ssc-runs { display: grid; gap: .5rem; margin: 0; padding: 0; list-style: none; }
.ssc-run { display: grid; gap: .35rem; padding: .6rem .75rem; border: 1px solid var(--color-border); border-radius: 10px; }
.ssc-run-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: .25rem .75rem; }
.ssc-run-top b { overflow-wrap: anywhere; }
.ssc-run-line { flex: 1; font-size: var(--fs-sm); color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
.ssc-run.is-failed .ssc-run-line { color: var(--tone-warn-fg); }
.ssc-waiting { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem 1rem; padding: .65rem .8rem; border-radius: 10px; background: var(--tone-warn-bg); color: var(--tone-warn-fg); }
.ssc-waiting > div { display: grid; gap: .1rem; }
.ssc-waiting .apl-card-sub { color: inherit; opacity: .85; }
.ssc-history { display: grid; gap: .5rem; justify-items: start; }
.ssc-uploads { display: grid; gap: .4rem; width: 100%; margin: 0; padding: 0; list-style: none; }
.ssc-uploads > li { display: grid; gap: .4rem; padding: .55rem .7rem; border: 1px solid var(--color-border); border-radius: 10px; }
.ssc-uploads > li.is-undone { background: var(--color-bg-secondary); }
.ssc-upload-top { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .9rem; }
.ssc-upload-top > div { display: grid; flex: 1; min-width: 12rem; }
.ssc-saved { display: grid; gap: .25rem; margin: 0; padding: 0 0 0 .5rem; list-style: none; font-size: var(--fs-sm); }
.ssc-saved li { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem .8rem; }
.ssc-saved li > span { flex: 1; }
.ssc-drop { position: absolute; inset: -4px; z-index: 5; display: grid; place-items: center; border: 2px dashed var(--color-text); border-radius: 14px; background: var(--color-bg); opacity: .96; pointer-events: none; }
.ssc-drop div { display: grid; gap: .2rem; text-align: center; }
.ssc-drop span { color: var(--color-text-secondary); font-size: var(--fs-sm); }
.ssc-family { display: grid; gap: .5rem; justify-items: start; }
.ssc-overlay { z-index: 1200; }
.ssc-check-body { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); grid-auto-rows: max-content; align-content: start; gap: 1.25rem; }
.ssc-page { margin: 0; display: grid; gap: .35rem; align-content: start; }
.ssc-page-img { all: unset; display: block; overflow: auto; max-height: min(70vh, 760px); border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-secondary); cursor: zoom-in; }
.ssc-page-img:focus-visible { outline: 2px solid var(--color-text); outline-offset: 2px; }
.ssc-page-img img { display: block; width: 100%; height: auto; }
.ssc-page.is-zoom .ssc-page-img { cursor: zoom-out; }
.ssc-page.is-zoom .ssc-page-img img { width: 200%; max-width: none; }
.ssc-form { display: grid; gap: .75rem; align-content: start; }
.ssc-why ul { margin: .25rem 0 0; padding-left: 1.1rem; }
.ssc-who-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: .6rem; }
.ssc-who-row label { display: grid; gap: .3rem; font-size: var(--fs-xs); font-weight: 600; color: var(--color-text-secondary); }
.ssc-who-row .apl-card-sub { font-weight: 400; }
.ssc-rows { display: grid; gap: .25rem; margin: 0; padding: 0; list-style: none; }
.ssc-row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .35rem .5rem; border: 1px solid transparent; border-radius: 9px; }
.ssc-row.is-flag { background: var(--tone-warn-bg); }
.ssc-row.is-row { border-color: var(--color-text); }
.ssc-row-name { display: grid; min-width: 0; font-size: var(--fs-sm); }
.ssc-row-name small { color: var(--tone-warn-fg); font-size: var(--fs-xs); }
.ssc-pick { display: inline-flex; gap: .25rem; flex: none; }
.ssc-pick button { width: 34px; height: 34px; border: 1px solid var(--color-border); border-radius: 8px; font-weight: 700; cursor: pointer; opacity: .55; }
.ssc-pick button.is-on { opacity: 1; box-shadow: inset 0 0 0 2px var(--color-text); }
.ssc-pick button:focus-visible { outline: 2px solid var(--color-text); outline-offset: 1px; }
.ssc-total { display: flex; align-items: baseline; gap: .5rem; padding-top: .5rem; border-top: 1px solid var(--color-border); }
.ssc-total b { font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
.ssc-cover { display: grid; gap: .6rem; padding: 1rem; border: 1px dashed var(--color-border-strong); border-radius: 10px; }
.ssc-cover p { margin: 0; font-size: var(--fs-sm); }
.ssc-cover div { display: flex; gap: .5rem; }
.ssc-notes { margin: 0; }
.ssc-check-sub { overflow-wrap: anywhere; white-space: normal; }
.ssc-check .kd-dialog__titles { min-width: 0; }
.ssc-page-hidden { display: grid; place-items: center; min-height: 240px; padding: 1.5rem; border: 1px dashed var(--color-border-strong); border-radius: 10px; text-align: center; color: var(--color-text-secondary); font-size: var(--fs-sm); }
.ssc-page-hidden p { margin: 0; max-width: 30ch; }
.ssc-line { font-size: var(--fs-xs); line-height: 1.45; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.ssc-waiting .ssc-line { color: inherit; opacity: .85; }
.ssc-row-name small.is-quiet { color: var(--color-text-secondary); }
.ssc-keys { margin-right: auto; }
@media (max-width: 860px) {
  .ssc-check-body { grid-template-columns: minmax(0, 1fr); }
  .ssc-page-img { max-height: 45vh; }
  .ssc-keys { display: none; }
}
@media (max-width: 520px) {
  .ssc-long { display: none; }
  .ssc-short { display: inline; }
  .ssc-check .kd-dialog__foot .btn { flex: 1; white-space: nowrap; }
  .ssc-row { display: grid; gap: .35rem; }
  .ssc-pick { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .ssc-pick button { width: auto; }
  .ssc-who-row { grid-template-columns: minmax(0, 1fr); }
  .ssc-actions, .ssc-add { width: 100%; }
  .ssc-add .btn, .ssc-actions > .btn { flex: 1; }
  .ssc-who, .ssc-who select { width: 100%; }
  .ssc-pick button { width: 40px; height: 40px; }
}
@media (pointer: coarse) {
  .ssc-pick button { min-width: 44px; min-height: 44px; }
  .ssc-uploads .apl-more, .ssc-saved .apl-more, .ssc-run .apl-more, .ssc-history > .apl-more { min-height: 44px; padding: 0 .5rem; }
}
`;
  document.head.appendChild(el);
}
