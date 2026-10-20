/**
 * The makeover application in the browser (/apply/form/)
 * ===========================================================================
 * The page renders every question from functions/api/_application-form.js;
 * this script walks the family through it one page at a time with the same
 * definition: show/hide rules, checks, stop screens. It saves to /api/apply
 * as they go (a draft keyed by a token kept in localStorage and in the
 * emailed resume link), uploads photos (resized here to JPEG) and the video
 * (straight to Cloudflare Stream over tus, resumable), shows a review page,
 * and submits.
 */
import * as tus from 'tus-js-client';
import {
  applicationForm, allFields, isVisible, stopFor, formErrors, answerSections, STOPS,
} from '../../../functions/api/_application-form.js';

const API = '/api/apply';
const STORE_KEY = 'soard-application-draft';
const CHUNK = 10 * 1024 * 1024; // tus chunks: small enough for a phone on a weak signal
const PHOTO_MAX = 2560;
const THUMB_MAX = 800;

const store = {
  get() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; } },
  set(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem(STORE_KEY); } catch { /* private mode */ } },
};

async function api(body) {
  const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch { data = { ok: false, error: 'Something went wrong. Please try again.' }; }
  return { status: res.status, ...data };
}

// The site uses Astro's ClientRouter: run on every visit to the page, not just the first load
document.addEventListener('astro:page-load', () => {
  const root = document.querySelector('[data-application]');
  if (root && !root.dataset.ready) init(root);
});

function init(root) {
  // Listeners on document/window end when the page is swapped out
  const life = new AbortController();
  const { signal } = life;
  document.addEventListener('astro:before-swap', () => life.abort(), { once: true });
  const year = root.dataset.year;
  const form = applicationForm({ year });
  const fields = allFields(form);
  const byId = Object.fromEntries(fields.map(f => [f.id, f]));
  const pageIds = form.pages.map(p => p.id);
  const pageEls = Object.fromEntries([...root.querySelectorAll('[data-page]')].map(el => [el.dataset.page, el]));
  const steps = [...pageIds, 'review'];
  const $ = (sel) => root.querySelector(sel);
  const fieldEl = (id) => root.querySelector(`[data-field="${id}"]`);

  const ui = {
    form: $('[data-form]'),
    stepText: $('[data-step-text]'),
    stepTitle: $('[data-step-title]'),
    bar: $('[data-progress-bar]'),
    back: $('[data-back]'),
    next: $('[data-next]'),
    saveLater: $('[data-save-later]'),
    saveState: $('[data-save-state]'),
    notice: $('[data-notice]'),
    stop: $('[data-stop]'),
    done: $('[data-done]'),
    review: $('[data-review]'),
    honeypot: $('[data-honeypot]'),
    turnstile: $('[data-turnstile]'),
    dialog: root.querySelector('[data-later-dialog]'),
  };

  let token = null;
  let current = 0;
  let files = {};          // fieldId → { key|uid, uploaded, name } (enough for formErrors)
  let saveChain = Promise.resolve();
  let dirtyTimer = null;
  let turnstileToken = null;
  let turnstileSiteKey = null;
  const uploads = new Set();

  // ── Reading and writing answers ──────────────────────────────────
  function readField(f) {
    const el = fieldEl(f.id);
    if (!el) return undefined;
    switch (f.type) {
      case 'radio': return el.querySelector('input:checked')?.value || '';
      case 'checkbox': return [...el.querySelectorAll('input:checked')].map(i => i.value);
      case 'ack': return el.querySelector('input:checked') ? f.options[0] : '';
      case 'name': case 'address':
        return Object.fromEntries([...el.querySelectorAll('[data-part]')].map(i => [i.dataset.part, i.value.trim()]));
      default: return el.querySelector('input, textarea, select')?.value ?? '';
    }
  }
  function writeField(f, v) {
    const el = fieldEl(f.id);
    if (!el || v == null) return;
    switch (f.type) {
      case 'radio': el.querySelectorAll('input').forEach(i => { i.checked = i.value === v; }); break;
      case 'checkbox': el.querySelectorAll('input').forEach(i => { i.checked = Array.isArray(v) && v.includes(i.value); }); break;
      case 'ack': el.querySelectorAll('input').forEach(i => { i.checked = v === f.options[0]; }); break;
      case 'name': case 'address':
        el.querySelectorAll('[data-part]').forEach(i => { if (v[i.dataset.part] != null) i.value = v[i.dataset.part]; });
        break;
      default: {
        const input = el.querySelector('input, textarea, select');
        if (input && input.type !== 'file') input.value = v;
      }
    }
  }
  const inputFields = fields.filter(f => !['content', 'image', 'photo', 'video'].includes(f.type));
  function readAnswers() {
    const out = {};
    for (const f of inputFields) {
      const v = readField(f);
      if (v !== undefined) out[f.id] = v;
    }
    return out;
  }

  // ── Show/hide and choice limits ──────────────────────────────────
  function refresh() {
    const answers = readAnswers();
    for (const f of fields) {
      if (!f.showIf) continue;
      const el = fieldEl(f.id);
      if (el) el.hidden = !isVisible(f, answers, byId);
    }
    for (const f of fields.filter(x => x.type === 'checkbox' && x.max)) {
      const el = fieldEl(f.id);
      const picked = el.querySelectorAll('input:checked').length;
      el.querySelectorAll('input').forEach(i => { i.disabled = !i.checked && picked >= f.max; });
    }
  }

  // ── Errors ───────────────────────────────────────────────────────
  function clearErrors(pageId) {
    pageEls[pageId]?.querySelectorAll('.af-field--error').forEach(el => {
      el.classList.remove('af-field--error');
      el.querySelector('.af-error').textContent = '';
      el.querySelectorAll('[aria-invalid]').forEach(i => i.removeAttribute('aria-invalid'));
    });
  }
  function showErrors(errors) {
    let first = null;
    for (const [id, msg] of Object.entries(errors)) {
      const el = fieldEl(id);
      if (!el) continue;
      el.classList.add('af-field--error');
      el.querySelector('.af-error').textContent = msg;
      el.querySelectorAll('input:not([type=file]), textarea, select').forEach(i => i.setAttribute('aria-invalid', 'true'));
      if (!first) first = el;
    }
    if (first) {
      first.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      (first.querySelector('input:not([type=file]):not([disabled]), textarea, select, button') || first).focus({ preventScroll: true });
    }
  }
  function clearFieldError(el) {
    if (!el?.classList.contains('af-field--error')) return;
    el.classList.remove('af-field--error');
    el.querySelector('.af-error').textContent = '';
    el.querySelectorAll('[aria-invalid]').forEach(i => i.removeAttribute('aria-invalid'));
  }

  // ── Notices ──────────────────────────────────────────────────────
  function notice(text, kind = 'info') {
    ui.notice.textContent = text || '';
    ui.notice.dataset.kind = kind;
    ui.notice.hidden = !text;
  }
  function saveState(text) { ui.saveState.textContent = text; }

  // ── Server calls ─────────────────────────────────────────────────
  async function start() {
    if (token) return true;
    if (turnstileSiteKey && !turnstileToken) {
      notice('Please complete the quick check above the Next button.', 'error');
      return false;
    }
    const r = await api({ action: 'start', year, turnstileToken, website: ui.honeypot?.value || '' });
    if (!r.ok) {
      notice(r.error || 'We could not start your application. Please try again.', 'error');
      if (r.code === 'turnstile') resetTurnstile();
      return false;
    }
    token = r.token;
    store.set({ token, year });
    return true;
  }

  function save() {
    if (!token) return Promise.resolve(true);
    clearTimeout(dirtyTimer);
    saveState('Saving…');
    const body = { action: 'save', token, answers: readAnswers(), page: pageIds[Math.min(current, pageIds.length - 1)] };
    saveChain = saveChain.then(async () => {
      try {
        const r = await api(body);
        if (r.ok) { saveState('All changes saved'); return true; }
        if (r.code === 'no-draft') { expired(); return false; }
        saveState(r.status === 429 ? 'Saving paused for a moment' : 'Not saved yet. We will try again.');
        return false;
      } catch {
        saveState('Offline. Your answers will save when you reconnect.');
        return false;
      }
    });
    return saveChain;
  }
  function markDirty() {
    if (!token) return;
    saveState('Unsaved changes');
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(save, 4000);
  }
  function expired() {
    store.clear();
    token = null;
    notice('This saved application has expired. Please start a new one; we are sorry for the trouble.', 'error');
  }

  // ── Steps ────────────────────────────────────────────────────────
  function render({ focus = true } = {}) {
    const step = steps[current];
    for (const [id, el] of Object.entries(pageEls)) el.hidden = id !== step;
    const title = step === 'review' ? 'Review and submit' : form.pages[current].title;
    ui.stepText.textContent = `Step ${current + 1} of ${steps.length}`;
    ui.stepTitle.textContent = title;
    ui.bar.style.width = `${Math.round(((current + 1) / steps.length) * 100)}%`;
    ui.back.hidden = current === 0;
    ui.next.textContent = step === 'review' ? 'Submit application' : current === pageIds.length - 1 ? 'Review my answers' : 'Next';
    ui.next.classList.toggle('af-btn--submit', step === 'review');
    if (ui.turnstile) ui.turnstile.hidden = !(current === 0 && turnstileSiteKey && !token);
    if (step === 'review') buildReview();
    if (focus) {
      const top = ui.form.getBoundingClientRect().top + window.scrollY - (parseInt(getComputedStyle(document.documentElement).scrollPaddingTop) || 96);
      window.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      ui.stepTitle.focus({ preventScroll: true });
    }
  }

  async function next() {
    notice('');
    const step = steps[current];
    if (step === 'review') return submit();
    const answers = readAnswers();
    clearErrors(step);
    const errors = formErrors(form, answers, files, [step]);
    if (Object.keys(errors).length) { showErrors(errors); return; }
    const stop = stopFor(form, answers);
    if (stop && stop.page === step) { showStop(stop); return; }
    ui.next.disabled = true;
    try {
      if (!(await start())) return;
      current += 1;
      save();
      render();
    } finally {
      ui.next.disabled = false;
    }
  }
  function back() {
    notice('');
    if (current === 0) return;
    current -= 1;
    save();
    render();
  }

  // ── Stop screens ─────────────────────────────────────────────────
  function showStop(stop) {
    const s = STOPS[stop.key];
    ui.stop.querySelector('[data-stop-title]').textContent = s.title;
    ui.stop.querySelector('[data-stop-body]').innerHTML = s.body;
    ui.stop.querySelector('[data-stop-map]').hidden = !s.image;
    ui.stop.hidden = false;
    ui.form.hidden = true;
    ui.stop.dataset.page = stop.page;
    ui.stop.querySelector('[data-stop-title]').focus();
    save();
  }
  ui.stop.querySelector('[data-stop-back]').addEventListener('click', () => {
    ui.stop.hidden = true;
    ui.form.hidden = false;
    render();
  });

  // ── Review ───────────────────────────────────────────────────────
  function buildReview() {
    const sections = answerSections(form, readAnswers(), files);
    ui.review.replaceChildren(...sections.map(s => {
      const sec = document.createElement('section');
      sec.className = 'af-review-section';
      const head = document.createElement('div');
      head.className = 'af-review-head';
      const h = document.createElement('h3');
      h.textContent = s.title;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'af-btn af-btn--link';
      edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit ${s.title}`);
      edit.addEventListener('click', () => { current = pageIds.indexOf(s.id); render(); });
      head.append(h, edit);
      const dl = document.createElement('dl');
      for (const item of s.items) {
        const dt = document.createElement('dt');
        dt.textContent = item.label;
        const dd = document.createElement('dd');
        dd.textContent = item.upload ? (item.type === 'video' ? 'Video uploaded' : `Photo added${item.file?.name ? ` (${item.file.name})` : ''}`) : item.text;
        dl.append(dt, dd);
      }
      sec.append(head, dl);
      return sec;
    }));
  }

  async function submit() {
    if (uploads.size) { notice('Please wait for your uploads to finish, then submit.', 'error'); return; }
    ui.next.disabled = true;
    ui.next.textContent = 'Submitting…';
    try {
      await save();
      const r = await api({ action: 'submit', token });
      if (r.ok) { finished(); return; }
      if (r.code === 'no-draft') { expired(); return; }
      if (r.error === 'stopped' && r.stop) { showStop({ key: r.stop, page: stopFor(form, readAnswers())?.page }); return; }
      if (r.errors) {
        const firstId = Object.keys(r.errors)[0];
        const page = byId[firstId]?.page;
        if (page) { current = pageIds.indexOf(page); render({ focus: false }); }
        showErrors(r.errors);
        notice('A few answers need attention before you submit.', 'error');
        return;
      }
      notice(r.error || 'We could not submit just now. Please try again in a minute.', 'error');
    } catch {
      notice('You seem to be offline. Your answers are saved; please try again when you are connected.', 'error');
    } finally {
      ui.next.disabled = false;
      if (steps[current] === 'review') ui.next.textContent = 'Submit application';
    }
  }

  function finished(already = false) {
    store.clear();
    ui.form.hidden = true;
    ui.stop.hidden = true;
    ui.done.hidden = false;
    const email = readAnswers().parentEmail;
    const emailLine = ui.done.querySelector('[data-done-email]');
    if (already) emailLine.textContent = 'This application has already been submitted. Thank you!';
    else if (email) emailLine.textContent = `We just sent a message to ${email} from our Qualification Committee with a copy of your application.`;
    ui.done.querySelector('[data-done-title]').focus();
    window.scrollTo({ top: ui.done.getBoundingClientRect().top + window.scrollY - 120 });
  }

  // ── Photos ───────────────────────────────────────────────────────
  async function toJpeg(file, max, quality) {
    let bmp = null;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
      try { bmp = await createImageBitmap(file); } catch { return null; }
    }
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return new Promise(r => canvas.toBlob(b => r(b), 'image/jpeg', quality));
  }

  function setUploadUi(el, { state, status, previewUrl, progress }) {
    const box = el.querySelector('.af-upload');
    if (state) box.dataset.state = state;
    if (status != null) box.querySelector('.af-upload-status').textContent = status;
    const hasFile = box.dataset.state === 'done';
    box.querySelector('[data-act="remove"]').hidden = !hasFile;
    box.querySelector('[data-act="choose"]').textContent = hasFile
      ? (el.dataset.type === 'video' ? 'Choose a different video' : 'Replace photo')
      : (el.dataset.type === 'video' ? 'Choose or record a video' : 'Choose a photo');
    const preview = box.querySelector('.af-upload-preview');
    if (preview && previewUrl !== undefined) preview.style.backgroundImage = previewUrl ? `url("${previewUrl}")` : '';
    const prog = box.querySelector('.af-progress');
    if (prog) {
      prog.hidden = progress == null;
      if (progress != null) prog.querySelector('.af-progress-bar').style.width = `${progress}%`;
    }
  }

  async function uploadPhoto(f, file) {
    const el = fieldEl(f.id);
    if (!(await start())) return;
    uploads.add(f.id);
    clearFieldError(el);
    setUploadUi(el, { state: 'busy', status: 'Getting your photo ready…' });
    try {
      const main = await toJpeg(file, PHOTO_MAX, 0.86);
      const thumb = main ? await toJpeg(main, THUMB_MAX, 0.72) : null;
      const body = new FormData();
      body.append('action', 'photo');
      body.append('token', token);
      body.append('field', f.id);
      const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + (main ? '.jpg' : '');
      body.append('file', main || file, main ? name : file.name);
      if (thumb) body.append('thumb', thumb, 'thumb.jpg');
      setUploadUi(el, { status: 'Uploading…' });
      const res = await fetch(API, { method: 'POST', body });
      const r = await res.json().catch(() => ({ ok: false }));
      if (!r.ok) throw new Error(r.error || 'Upload failed');
      files[f.id] = { key: true, name };
      setUploadUi(el, { state: 'done', status: `Added: ${name}`, previewUrl: URL.createObjectURL(thumb || main || file) });
    } catch (e) {
      setUploadUi(el, { state: files[f.id] ? 'done' : 'empty', status: `${e.message || 'Upload failed'}. Please try again.` });
    } finally {
      uploads.delete(f.id);
    }
  }

  // ── Video ────────────────────────────────────────────────────────
  async function uploadVideo(f, file) {
    const el = fieldEl(f.id);
    if (!file.size) { setUploadUi(el, { status: 'That file is empty. If it is in iCloud or Google Drive, download it to your phone first.' }); return; }
    if (!(await start())) return;
    clearFieldError(el);
    uploads.add(f.id);
    files.video = { uid: true, uploaded: false, name: file.name };
    setUploadUi(el, { state: 'busy', status: 'Starting upload…', progress: 0 });
    try {
      const r = await api({ action: 'video-url', token, size: file.size, name: file.name });
      if (!r.ok) throw new Error(r.error || 'Could not start the upload');
      await new Promise((resolve, reject) => {
        const upload = new tus.Upload(file, {
          uploadUrl: r.uploadUrl,
          chunkSize: CHUNK,
          retryDelays: [0, 2000, 5000, 10000, 20000, 40000, 60000],
          metadata: { filename: file.name, filetype: file.type },
          storeFingerprintForResuming: false,
          onError: reject,
          onProgress(sent, total) {
            const pct = Math.floor((sent / total) * 100);
            setUploadUi(el, { status: `Uploading your video… ${pct}%`, progress: pct });
          },
          onSuccess: resolve,
        });
        upload.start();
      });
      setUploadUi(el, { status: 'Finishing up…', progress: 100 });
      let uploaded = false;
      for (let i = 0; i < 20 && !uploaded; i++) {
        const done = await api({ action: 'video-done', token });
        if (done.code === 'video-error') throw new Error(done.error);
        uploaded = !!done.uploaded;
        if (!uploaded) await new Promise(res => setTimeout(res, 1500));
      }
      if (!uploaded) throw new Error('The video did not finish uploading');
      files.video = { uid: true, uploaded: true, name: file.name };
      setUploadUi(el, { state: 'done', status: `Video uploaded: ${file.name}`, progress: null });
    } catch (e) {
      delete files.video;
      setUploadUi(el, { state: 'empty', status: `${e.message || 'Upload failed'}. Please try again.`, progress: null });
    } finally {
      uploads.delete(f.id);
    }
  }

  async function removeFile(f) {
    const el = fieldEl(f.id);
    delete files[f.id];
    setUploadUi(el, { state: 'empty', status: f.type === 'video' ? 'No video yet' : 'No photo yet', previewUrl: '', progress: null });
    if (token) await api({ action: 'remove-file', token, field: f.id });
  }

  for (const f of fields.filter(x => x.type === 'photo' || x.type === 'video')) {
    const el = fieldEl(f.id);
    const input = el.querySelector('input[type=file]');
    el.querySelector('[data-act="choose"]').addEventListener('click', () => input.click());
    el.querySelector('[data-act="remove"]').addEventListener('click', () => removeFile(f));
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      if (f.type === 'video') uploadVideo(f, file); else uploadPhoto(f, file);
    });
  }

  // ── Save and finish later ────────────────────────────────────────
  const dlg = ui.dialog;
  ui.saveLater.addEventListener('click', () => {
    const email = readAnswers().parentEmail;
    const input = dlg.querySelector('input[type=email]');
    if (email && !input.value) input.value = email;
    dlg.querySelector('[data-later-status]').textContent = '';
    dlg.querySelector('[data-later-form]').hidden = false;
    dlg.querySelector('[data-later-sent]').hidden = true;
    dlg.showModal();
  });
  dlg.querySelector('[data-later-close]').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('[data-later-done]').forEach(b => b.addEventListener('click', () => dlg.close()));
  dlg.querySelector('[data-later-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = dlg.querySelector('[data-later-status]');
    const email = dlg.querySelector('input[type=email]').value.trim();
    const btn = dlg.querySelector('[data-later-form] button[type=submit]');
    btn.disabled = true;
    status.textContent = 'Sending…';
    try {
      if (!(await start())) { status.textContent = ui.notice.textContent; return; }
      await save();
      const r = await api({ action: 'email-link', token, email });
      if (!r.ok) { status.textContent = r.error || 'We could not send the email. Please try again.'; return; }
      dlg.querySelector('[data-later-email]').textContent = email;
      dlg.querySelector('[data-later-form]').hidden = true;
      dlg.querySelector('[data-later-sent]').hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // ── Open/closed + Turnstile, from the live settings ──────────────
  const closedCard = document.querySelector('[data-closed]');
  function showApp(open) {
    root.hidden = !open;
    if (closedCard) closedCard.hidden = open;
  }
  function resetTurnstile() {
    turnstileToken = null;
    try { window.turnstile?.reset(ui.turnstile.querySelector('.cf-turnstile')); } catch { /* not loaded */ }
  }
  async function loadConfig() {
    let cfg = null;
    try { cfg = await (await fetch(`${API}?config`)).json(); } catch { return; } // offline: keep what the page was built with
    // ?preview=1 shows the form while closed; the server still only lets signed-in staff start one
    const preview = new URLSearchParams(location.search).has('preview');
    if (!token) showApp(!!cfg.open || preview);
    if (!cfg.turnstileSiteKey || token) return;
    turnstileSiteKey = cfg.turnstileSiteKey;
    window.onSoardTurnstile = () => {
      window.turnstile.render(ui.turnstile.querySelector('.cf-turnstile'), {
        sitekey: turnstileSiteKey,
        callback: (t) => { turnstileToken = t; notice(''); },
        'expired-callback': () => { turnstileToken = null; },
      });
    };
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onSoardTurnstile&render=explicit';
    s.async = true;
    document.head.append(s);
    render({ focus: false });
  }

  // ── Resume ───────────────────────────────────────────────────────
  async function resume() {
    const params = new URLSearchParams(location.search);
    const fromLink = params.get('resume');
    if (fromLink) history.replaceState(null, '', location.pathname); // keep the token out of screenshots and shares
    const saved = store.get();
    const candidate = fromLink || saved?.token;
    if (!candidate || !/^[0-9a-f]{32}$/.test(candidate)) return;
    const r = await api({ action: 'resume', token: candidate }).catch(() => null);
    if (!r?.ok) {
      if (fromLink) notice('That link has expired or is not valid. Please start a new application.', 'error');
      store.clear();
      return;
    }
    token = candidate;
    store.set({ token, year: r.year });
    showApp(true); // a saved application can always be finished, even after we close
    for (const f of inputFields) writeField(f, r.answers?.[f.id]);
    for (const [id, pf] of Object.entries(r.files || {})) {
      const f = byId[id];
      const el = fieldEl(id);
      if (!f || !el) continue;
      if (id === 'video') {
        if (pf.uploaded) { files.video = { uid: true, uploaded: true, name: pf.name }; setUploadUi(el, { state: 'done', status: `Video uploaded: ${pf.name || 'your video'}` }); }
        else setUploadUi(el, { status: 'Your video did not finish uploading. Please choose it again.' });
      } else {
        files[id] = { key: true, name: pf.name };
        setUploadUi(el, { state: 'done', status: `Added: ${pf.name || 'your photo'}` });
      }
    }
    refresh();
    if (r.submitted) { finished(true); return; }
    const at = pageIds.indexOf(r.page);
    current = at >= 0 ? at : 0;
    render({ focus: false });
    notice('Welcome back! Your answers are saved, so you can pick up right where you left off.', 'success');
  }

  // ── Wire up ──────────────────────────────────────────────────────
  ui.form.addEventListener('submit', (e) => { e.preventDefault(); next(); });
  ui.back.addEventListener('click', back);
  ui.form.addEventListener('input', (e) => {
    clearFieldError(e.target.closest('[data-field]'));
    refresh();
    markDirty();
  });
  ui.form.addEventListener('change', () => { refresh(); markDirty(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && token) save(); }, { signal });
  window.addEventListener('beforeunload', (e) => {
    if (uploads.size) { e.preventDefault(); e.returnValue = ''; }
  }, { signal });
  // Leaving through a site link doesn't fire beforeunload; ask before an upload is cut off
  document.addEventListener('astro:before-preparation', (e) => {
    if (uploads.size && !confirm('Your upload is still in progress. Leave this page and stop it?')) e.preventDefault();
    else if (token) save();
  }, { signal });

  root.dataset.ready = '1';
  refresh();
  render({ focus: false });
  resume().finally(() => { if (!token) loadConfig(); });
}
