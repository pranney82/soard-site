/**
 * The photo box: photos from the phone straight onto a JobTread daily log
 * ===========================================================================
 * One box, two places. Inside Claude it's the SOARD connection's window (functions/api/_mcp/field.js, which
 * reaches the site through Claude); in a browser it's /admin/photos/, the backup for a phone whose Claude app
 * won't open the camera from inside a chat. Each hands mountPhotoBox its own way to ask the site for upload
 * slots (slots) and to put the sent photos on the log (done); the box does the rest the same way in both.
 *
 * Each photo goes from the phone to JobTread's storage directly (the slot is a signed address JobTread made for
 * that one file), never through the chat or the site, so it arrives full size. Three go at a time. A photo
 * whose signal drops waits with "Try again"; a retry sends it to the same slot, and the site puts each upload on
 * the log only once. Its name in the file: photo-box-<version>.js, because /mcp-app/ is cached for a year.
 */

const CSS = `
.pb { --fg: var(--color-text-primary, #1f1d1a); --muted: var(--color-text-secondary, #5f5a54); --line: var(--color-border-primary, rgba(0,0,0,.14));
  --bg: var(--color-background-primary, #fff); --soft: var(--color-background-secondary, #f4f2ee); --ink: #1f1d1a; --on-ink: #fff;
  --warn-bg: #fdf3d9; --warn-fg: #6b4300; --warn: #a15c00;
  color: var(--fg); font: 15px/1.45 var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif); display: grid; gap: 12px; padding: 14px; }
@media (prefers-color-scheme: dark) { .pb.pb-auto { --fg: var(--color-text-primary, #f2efe9); --muted: var(--color-text-secondary, #b4ada4); --line: var(--color-border-primary, rgba(255,255,255,.16));
  --bg: var(--color-background-primary, #1d1c1a); --soft: var(--color-background-secondary, #2a2926); --ink: #f2efe9; --on-ink: #1d1c1a; --warn-bg: #3a2c0c; --warn-fg: #f6d58e; --warn: #f0b24a; } }
.pb * { box-sizing: border-box; }
.pb-kicker { font-size: 12px; color: var(--muted); }
.pb-title { font-weight: 650; font-size: 16px; overflow-wrap: anywhere; }
.pb-sub { font-size: 13px; color: var(--muted); }
.pb-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.pb-btn { min-height: 48px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; font-weight: 600;
  display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 12px; cursor: pointer; }
.pb-btn.pb-primary { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
.pb-btn:focus-visible, .pb-link:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.pb-btn[disabled] { opacity: .55; cursor: default; }
.pb-btn svg { flex: none; }
.pb-status { font-weight: 600; font-size: 14px; min-height: 1em; }
.pb-status:empty { display: none; }
.pb-bar { height: 4px; border-radius: 2px; background: var(--soft); overflow: hidden; }
.pb-fill { height: 4px; width: 0; background: var(--fg); transition: width .2s linear; }
.pb-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.pb-grid:empty { display: none; }
.pb-tile { position: relative; aspect-ratio: 1 / 1; border-radius: 10px; overflow: hidden; background: var(--soft); }
.pb-tile canvas { width: 100%; height: 100%; display: block; object-fit: cover; }
.pb-tile[data-state="waiting"] canvas, .pb-tile[data-state="sending"] canvas { opacity: .45; }
.pb-ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); }
.pb-badge { position: absolute; right: 4px; bottom: 4px; min-width: 22px; height: 22px; padding: 0 5px; border-radius: 11px; display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; background: var(--ink); color: var(--on-ink); }
.pb-tile[data-state="failed"] .pb-badge { background: var(--warn); color: #fff; }
.pb-problem { background: var(--warn-bg); color: var(--warn-fg); border-radius: 10px; padding: 10px 12px; font-size: 14px; }
.pb-after { display: flex; gap: 10px; }
.pb-after .pb-btn { flex: 1 1 0; min-width: 0; }
.pb-link { justify-self: start; font-size: 13px; color: var(--muted); text-decoration: underline; background: none; border: 0; padding: 4px 0; font: inherit; font-size: 13px; cursor: pointer; }
.pb-wait { color: var(--muted); font-size: 14px; }
[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { .pb-fill { transition: none; } }
`;

const svg = (paths, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const CAMERA = svg('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path><circle cx="12" cy="13" r="3"></circle>');
const PICTURES = svg('<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"></path>');
const PHOTO = svg('<path d="m3 17 5-5 4 4 3-3 6 6"></path><circle cx="16" cy="8" r="2"></circle>', 22);
const FILM = svg('<rect x="2" y="5" width="15" height="14" rx="2"></rect><path d="m17 10 5-3v10l-5-3"></path>', 22);
const CHECK = svg('<path d="M20 6 9 17l-5-5"></path>', 12);

const MAX = 30;
const AT_ONCE = 3;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', gif: 'image/gif', mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v' };
const typeOf = (f) => f.type || TYPES[String(f.name || '').split('.').pop().toLowerCase()] || 'application/octet-stream';
const dayLabel = (d) => {
  const t = Date.parse(`${d}T12:00:00Z`);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/**
 * Put the photo box in `root`.
 * opts: { slots(files) → [{ name, uploadId, url, method, headers } | { name, problem }],
 *         done({ jobId, date, logId, files: [{ uploadId, name }] }) → { logId, added, already, failed: [{ uploadId, problem }] },
 *         openLink(url), target?, theme?: 'light' (the admin page; Claude's box follows the chat) }
 * target: { jobId, jobName, date, logId, jobUrl, backupUrl, who }
 * → { setTarget(target), waiting(text) }
 */
export function mountPhotoBox(root, opts) {
  if (!document.getElementById('pb-style')) {
    const s = document.createElement('style');
    s.id = 'pb-style';
    s.textContent = CSS;
    document.head.append(s);
  }
  // In Claude it follows the chat's light or dark; the admin page is light only
  root.innerHTML = `<section class="pb${opts.theme === 'light' ? '' : ' pb-auto'}" aria-label="Photos for a daily log">
    <p class="pb-wait" data-r="wait">Opening the photo box…</p>
    <div data-r="head" hidden><div class="pb-kicker">Photos for the daily log</div><div class="pb-title" data-r="title"></div><div class="pb-sub" data-r="sub"></div></div>
    <div class="pb-actions" data-r="actions" hidden>
      <button type="button" class="pb-btn pb-primary" data-r="take">${CAMERA}<span>Take a photo</span></button>
      <button type="button" class="pb-btn" data-r="pick">${PICTURES}<span>Choose photos</span></button>
      <input type="file" accept="image/*" capture="environment" data-r="takeIn" hidden>
      <input type="file" accept="image/*,video/*" multiple data-r="pickIn" hidden>
    </div>
    <div class="pb-status" role="status" aria-live="polite" data-r="status"></div>
    <div class="pb-bar" data-r="bar" hidden><div class="pb-fill" data-r="fill"></div></div>
    <ul class="pb-grid" data-r="grid" aria-label="Photos"></ul>
    <div class="pb-problem" data-r="problem" hidden></div>
    <div class="pb-after" data-r="after" hidden>
      <button type="button" class="pb-btn pb-primary" data-r="retry" hidden>Try again</button>
      <button type="button" class="pb-btn" data-r="see" hidden>Open in JobTread</button>
    </div>
    <button type="button" class="pb-link" data-r="backup" hidden>Buttons not working? Open this in your browser</button>
  </section>`;
  const $ = (r) => root.querySelector(`[data-r="${r}"]`);
  const st = { target: null, items: [], busy: false };

  const show = (r, on) => { $(r).hidden = !on; };
  const say = (t) => { $('status').textContent = t; };

  function setTarget(t) {
    if (!t?.jobId || !t?.date) return waiting();
    const changed = !st.target || st.target.jobId !== t.jobId || st.target.date !== t.date;
    st.target = { ...(st.target || {}), ...t, logId: t.logId || (changed ? null : st.target?.logId) || null };
    show('wait', false); show('head', true); show('actions', true);
    $('title').textContent = t.jobName || 'This job';
    $('sub').textContent = `${dayLabel(t.date)} log · added as ${t.who || 'you'}`;
    show('backup', !!t.backupUrl);
    show('see', !!t.jobUrl && st.items.some((i) => i.state === 'done'));
    if (changed && st.items.length) { st.items = []; $('grid').replaceChildren(); paint(); }
  }
  /** Before there's a job: a line of words, and a button when there's somewhere to go first (connect JobTread) */
  function waiting(text, action) {
    if (st.target) return;
    $('wait').textContent = text || 'Tell Claude which job, and the photo box opens here.';
    show('wait', true);
    root.querySelector('.pb-first')?.remove();
    if (action?.url) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'pb-btn pb-primary pb-first', textContent: action.label || 'Open' });
      b.onclick = () => opts.openLink?.(action.url);
      $('wait').after(b);
    }
  }

  $('take').onclick = () => $('takeIn').click();
  $('pick').onclick = () => $('pickIn').click();
  for (const r of ['takeIn', 'pickIn']) $(r).onchange = (e) => { const files = [...(e.target.files || [])]; e.target.value = ''; add(files); };
  $('retry').onclick = () => retry();
  $('see').onclick = () => st.target?.jobUrl && opts.openLink?.(st.target.jobUrl);
  $('backup').onclick = () => st.target?.backupUrl && opts.openLink?.(st.target.backupUrl);

  // ── Tiles ──
  function tile(it) {
    const li = document.createElement('li');
    li.className = 'pb-tile';
    li.innerHTML = `<div class="pb-ph">${it.video ? FILM : PHOTO}</div><span class="pb-badge" hidden></span>`;
    li.setAttribute('aria-label', it.file.name || 'Photo');
    it.el = li;
    $('grid').append(li);
    if (!it.video) thumb(it);
    return li;
  }
  async function thumb(it) {
    try {
      const bmp = await createImageBitmap(it.file, { resizeWidth: 240, resizeQuality: 'medium' });
      const c = document.createElement('canvas');
      const side = Math.min(bmp.width, bmp.height);
      c.width = 200; c.height = 200;
      c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 200, 200);
      bmp.close?.();
      it.el.querySelector('.pb-ph')?.remove();
      it.el.prepend(c);
    } catch { /* the picture icon stays */ }
  }
  function badge(it) {
    const b = it.el.querySelector('.pb-badge');
    it.el.dataset.state = it.state;
    if (it.state === 'done') { b.innerHTML = CHECK; b.hidden = false; b.setAttribute('aria-label', 'Added'); }
    else if (it.state === 'failed') { b.textContent = '!'; b.hidden = false; b.setAttribute('aria-label', it.problem || 'Didn’t go through'); }
    else if (it.state === 'sending' && it.sent > 0) { b.textContent = `${Math.round(it.sent * 100)}%`; b.hidden = false; }
    else b.hidden = true;
  }

  // ── Status ──
  function paint() {
    const all = st.items;
    const n = all.length;
    const done = all.filter((i) => i.state === 'done').length;
    const bad = all.filter((i) => i.state === 'failed');
    all.forEach(badge);
    const bytes = all.reduce((s, i) => s + i.file.size, 0) || 1;
    const sent = all.reduce((s, i) => s + i.file.size * (i.state === 'done' || i.state === 'sent' ? 1 : i.state === 'sending' ? (i.sent || 0) : 0), 0);
    show('bar', st.busy);
    $('fill').style.width = `${Math.round((sent / bytes) * 100)}%`;
    if (!n) say('');
    else if (st.busy) say(`${done} of ${n} added`);
    else if (!bad.length) say(`${done} ${done === 1 ? 'photo is' : 'photos are'} on the log`);
    else say(`${done} of ${n} added`);
    show('problem', !st.busy && (bad.length > 0 || !!st.note));
    if (!st.busy && bad.length) {
      const why = [...new Set(bad.map((i) => i.problem).filter(Boolean))].slice(0, 2).join(' ');
      $('problem').textContent = `${bad.length} didn’t go through.${why ? ` ${why}` : ''} They’re still on your phone.${st.note ? ` ${st.note}` : ''}`;
    } else if (st.note) $('problem').textContent = st.note;
    const retryable = bad.some((i) => !i.fatal);
    show('retry', !st.busy && retryable);
    show('see', !st.busy && done > 0 && !!st.target?.jobUrl);
    show('after', !$('retry').hidden || !$('see').hidden);
    $('take').disabled = $('pick').disabled = st.busy;
    $('take').querySelector('span').textContent = done ? 'Take another' : 'Take a photo';
    $('pick').querySelector('span').textContent = done ? 'Add more' : 'Choose photos';
  }

  // ── Sending ──
  async function add(files) {
    if (!files.length) return;
    if (!st.target) return waiting();
    if (st.busy) return;
    const take = files.slice(0, MAX);
    const fresh = take.map((file) => ({ file, type: typeOf(file), video: typeOf(file).startsWith('video/'), state: 'waiting', sent: 0 }));
    fresh.forEach((it) => { st.items.push(it); tile(it); });
    st.note = files.length > MAX ? `Up to ${MAX} go at a time: the first ${MAX} went. Add the rest next.` : '';
    await run(fresh);
  }

  async function run(list) {
    st.busy = true;
    paint();
    try {
      const need = list.filter((i) => !i.slot);
      if (need.length) {
        let slots;
        try { slots = await opts.slots(need.map((i) => ({ name: i.file.name, type: i.type, size: i.file.size }))); }
        catch (err) { need.forEach((i) => Object.assign(i, { state: 'failed', problem: err.message })); slots = []; }
        need.forEach((it, k) => {
          const s = slots[k];
          if (s?.uploadId) Object.assign(it, { slot: s, name: s.name || it.file.name, state: 'waiting' });
          else if (s?.problem) Object.assign(it, { state: 'failed', problem: s.problem, fatal: true });
        });
      }
      const go = list.filter((i) => i.slot && (i.state === 'waiting' || (i.state === 'failed' && !i.sentOk)));
      let next = 0;
      const worker = async () => { while (next < go.length) { const it = go[next++]; await put(it); paint(); } };
      await Promise.all(Array.from({ length: Math.min(AT_ONCE, go.length) }, worker));
      const onLog = st.items.filter((i) => i.state === 'sent');
      if (onLog.length) {
        try {
          const r = await opts.done({ jobId: st.target.jobId, date: st.target.date, logId: st.target.logId || null, files: onLog.map((i) => ({ uploadId: i.slot.uploadId, name: i.name })) });
          if (r?.logId) st.target.logId = r.logId;
          const failed = new Map((r?.failed || []).map((f) => [f.uploadId, f.problem]));
          onLog.forEach((i) => { if (failed.has(i.slot.uploadId)) Object.assign(i, { state: 'failed', problem: failed.get(i.slot.uploadId) }); else i.state = 'done'; });
        } catch (err) {
          onLog.forEach((i) => Object.assign(i, { state: 'failed', problem: err.message || 'They didn’t go on the log.' }));
        }
      }
    } finally {
      st.busy = false;
      paint();
    }
  }

  function put(it) {
    it.state = 'sending';
    it.sent = 0;
    badge(it);
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open(it.slot.method || 'PUT', it.slot.url);
      for (const [k, v] of Object.entries(it.slot.headers || {})) x.setRequestHeader(k, v);
      x.upload.onprogress = (e) => { if (e.lengthComputable) { it.sent = e.loaded / e.total; badge(it); $('fill').style.width = `${Math.round(progress() * 100)}%`; } };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) Object.assign(it, { state: 'sent', sentOk: true, problem: '' });
        else Object.assign(it, { state: 'failed', problem: 'JobTread didn’t take it.' });
        resolve();
      };
      x.onerror = x.ontimeout = x.onabort = () => { Object.assign(it, { state: 'failed', problem: 'The signal dropped.' }); resolve(); };
      x.send(it.file);
    });
  }
  const progress = () => {
    const bytes = st.items.reduce((s, i) => s + i.file.size, 0) || 1;
    return st.items.reduce((s, i) => s + i.file.size * (i.state === 'done' || i.state === 'sent' ? 1 : i.state === 'sending' ? (i.sent || 0) : 0), 0) / bytes;
  };

  async function retry() {
    if (st.busy) return;
    // Sent but not yet on the log: only the log step again; never sent: send again to the same slot
    const again = st.items.filter((i) => i.state === 'failed' && !i.fatal);
    again.forEach((i) => { if (i.sentOk) i.state = 'sent'; else if (!i.slot) i.state = 'waiting'; });
    await run(again);
  }

  if (opts.target) setTarget(opts.target);
  return { setTarget, waiting };
}
