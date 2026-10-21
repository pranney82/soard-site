/**
 * event-recap-admin.js — "After the event" in the admin
 * ======================================================
 * Once an event is over its page is the recap: the pro photos, then the
 * sponsors (public/admin/events-shared.js has the rules). This module is the
 * admin's side of it, used by the Gala and Golf editors (their "After the
 * gala" / "After the tournament" tab) and by the Event editor:
 *
 *   AfterEventPanel   where the page stands (before / after, its addresses,
 *                     how many photos and sponsors it shows), the photographer's
 *                     photos (a whole folder at once), the photo credit, an
 *                     optional thank-you note and up to four numbers
 *   uploadPhotos      the bulk upload: three at a time, oversized camera files
 *                     shrunk in the browser to fit the 10 MB upload limit, each
 *                     named <folder>/<time>-<file> so the site knows which
 *                     year a gallery photo belongs to
 *   SponsorsList      an event's own sponsor list (kept once next year's is added)
 */
import { h, htm, useState, useRef } from './vendor.js';
import {
  seriesOf, isOver, isLatest, eventPath, yearPath, yearOf, fmtDay, recapPhotos, recapSponsors,
  sponsorCount, recapLead, cleanHighlights, HIGHLIGHTS_MAX, displayName, cleanSponsors,
} from './events-shared.js';

const html = htm.bind(h);
const MAX_BYTES = 9.5 * 1024 * 1024;
const LONG_EDGE = 4800;
const AT_ONCE = 3;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CSS = `
.er { display: grid; gap: 1.25rem; }
.er-status { display: flex; gap: 0.85rem; align-items: flex-start; padding: 1rem 1.1rem; border-radius: 12px; background: var(--bg-secondary); border: 1px solid var(--border); }
.er-status.is-over { background: rgba(46, 125, 50, 0.07); border-color: rgba(46, 125, 50, 0.28); }
.er-status__dot { flex-shrink: 0; width: 10px; height: 10px; margin-top: 0.4rem; border-radius: 50%; background: var(--text-tertiary); }
.er-status.is-over .er-status__dot { background: #2e7d32; box-shadow: 0 0 0 4px rgba(46, 125, 50, 0.15); }
.er-status__text { display: grid; gap: 0.25rem; font-size: 0.9rem; line-height: 1.5; }
.er-status__text a { color: inherit; font-weight: 600; }
.er-counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; }
.er-count { display: grid; gap: 0.1rem; padding: 0.9rem 1rem; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-primary, #fff); }
.er-count__n { font-size: 1.7rem; font-weight: 800; line-height: 1.1; }
.er-count__l { font-weight: 600; font-size: 0.88rem; }
.er-count__how { font-size: 0.8rem; color: var(--text-tertiary); }
.er-block { display: grid; gap: 0.8rem; padding-top: 0.25rem; }
.er-block h3 { margin: 0; font-size: 1rem; }
.er-hint { margin: 0; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.55; }
.er-drop { display: flex; gap: 0.9rem; align-items: center; padding: 1.15rem 1.2rem; border: 2px dashed var(--border); border-radius: 14px; background: var(--bg-secondary); color: var(--text-secondary); transition: border-color 0.15s, background 0.15s; }
.er-drop strong { display: block; color: var(--text-primary, inherit); font-size: 0.95rem; }
.er-drop span { font-size: 0.84rem; }
.er-drop.is-over { border-color: var(--color-primary); background: rgba(255, 213, 0, 0.1); }
.er-drop.is-busy { opacity: 0.75; }
.er-link { border: 0; background: none; padding: 0; font: inherit; color: inherit; font-weight: 700; text-decoration: underline; cursor: pointer; min-height: 0; }
.er-progress { height: 6px; border-radius: 3px; background: var(--bg-secondary); overflow: hidden; }
.er-progress span { display: block; height: 100%; background: var(--color-primary); transition: width 0.3s ease; }
.er-fail { padding: 0.8rem 1rem; border-radius: 10px; border: 1px solid rgba(180, 83, 9, 0.35); background: rgba(245, 158, 11, 0.08); font-size: 0.85rem; }
.er-fail ul { margin: 0.4rem 0; padding-left: 1.1rem; }
.er-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; }
.er-hl { display: grid; grid-template-columns: 7rem 1fr auto; gap: 0.5rem; margin-bottom: 0.45rem; }
.er-add { justify-self: start; }
.er-sp { display: grid; gap: 0.9rem; }
.er-sp__tier { display: grid; gap: 0.45rem; padding: 0.8rem; border: 1px solid var(--border); border-radius: 12px; }
.er-sp__head { display: grid; grid-template-columns: 1fr 10rem auto; gap: 0.5rem; }
.er-sp__name { display: grid; grid-template-columns: 64px 1fr auto; gap: 0.5rem; align-items: center; }
.er-sp__name img { width: 64px; height: 32px; object-fit: contain; }
.er-sp__nologo { font-size: 0.72rem; color: var(--text-tertiary); text-align: center; }
@media (max-width: 640px) { .er-sp__head { grid-template-columns: 1fr; } .er-hl { grid-template-columns: 5.5rem 1fr auto; } }
`;
function injectStyles() {
  let s = document.getElementById('er-style');
  if (!s) { s = document.createElement('style'); s.id = 'er-style'; document.head.append(s); }
  if (s.textContent !== CSS) s.textContent = CSS;
}

/** A camera file the upload limit would refuse, made smaller (same look, JPEG) */
export async function fitForUpload(file) {
  if (file.size <= MAX_BYTES) return file;
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, LONG_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const hgt = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, hgt);
  bmp.close?.();
  for (const q of [0.9, 0.82, 0.74]) {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= MAX_BYTES) return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  }
  throw new Error('too large even after shrinking');
}

/**
 * Upload photos into `folder`, three at a time. onDone(entry) for each one
 * uploaded ({ id, alt: '' }), in the order chosen; onProgress({ done, total, failed }).
 * Returns { ok: [entries], failed: [{ file, error }] }.
 */
export async function uploadPhotos(api, files, folder, { onProgress = () => {}, onDone = () => {} } = {}) {
  const list = [...files].filter((f) => f && /^image\//.test(f.type || ''));
  const out = new Array(list.length).fill(null);
  const failed = [];
  let next = 0;
  let done = 0;
  const one = async () => {
    while (next < list.length) {
      const i = next++;
      const file = list[i];
      try {
        const ready = await fitForUpload(file);
        const safe = ready.name.replace(/[^a-z0-9.]/gi, '-').toLowerCase();
        const id = `${folder}/${Date.now()}-${safe}`;
        const res = await api.uploadImage(ready, id);
        if (!res.success) throw new Error(res.error || 'upload failed');
        out[i] = { id: res.imageId || id, alt: '' };
        onDone(out[i], i);
      } catch (e) {
        failed.push({ file, error: e.message || String(e) });
      }
      done++;
      onProgress({ done, total: list.length, failed: failed.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, list.length) }, one));
  return { ok: out.filter(Boolean), failed };
}

/** Drop or choose many photos at once */
function PhotoDrop({ onFiles, busy, label }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  return html`
    <div class=${`er-drop ${over ? 'is-over' : ''} ${busy ? 'is-busy' : ''}`}
      onDragOver=${(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); if (!busy) onFiles(e.dataTransfer.files); }}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
      <div>
        <strong>${label}</strong>
        <span>Drag the whole folder’s photos here, or <button type="button" class="er-link" disabled=${busy} onClick=${() => input.current?.click()}>choose them</button>. Big camera files are made smaller to fit.</span>
      </div>
      <input ref=${input} type="file" accept="image/*" multiple hidden onChange=${(e) => { onFiles(e.target.files); e.target.value = ''; }} />
    </div>`;
}

/**
 * The "After the event" panel.
 *   event       the event record being edited (its photographer, note, numbers)
 *   events      every event, for which page it's on and what comes next
 *   pageDoc     the Gala or Golf editor's data (gallery photos, sponsors) or null
 *   onEvent     (field, value) → change the event record
 *   addPhotos   (entries) → add uploaded photos where this event's photos live
 *   afterUpload (count) → called once a batch is in (the editors save then)
 */
export function AfterEventPanel({ api, event, events = [], pageDoc = null, onEvent, addPhotos, afterUpload, addToast = () => {} }) {
  injectStyles();
  const ev = event || {};
  const series = seriesOf(ev);
  const all = events.some((e) => e.slug === ev.slug) ? events.map((e) => (e.slug === ev.slug ? ev : e)) : [...events, ev];
  const over = isOver(ev);
  const newest = !series || isLatest(ev, all);
  const path = eventPath(ev, all);
  const year = yearPath(ev, all);
  const photos = recapPhotos(ev, all, newest ? pageDoc : null);
  const sponsors = recapSponsors(ev, all, newest ? pageDoc : null);
  const nSponsors = sponsorCount(sponsors);
  const when = series?.key === 'gala' ? 'night' : 'day';
  const kind = series ? (series.key === 'gala' ? 'gala' : 'tournament') : 'event';
  const day = fmtDay(ev.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const highlights = Array.isArray(ev.highlights) ? ev.highlights : [];
  const [progress, setProgress] = useState(null);
  const [failures, setFailures] = useState([]);
  // The newest gala or tournament keeps its photos in its editor's Gallery; any other event, its own
  const inGallery = !!series && newest;
  const folder = inGallery ? `gallery/${series.key}` : `events/${ev.slug || 'new'}`;

  const upload = async (files) => {
    const list = [...(files || [])].filter((f) => /^image\//.test(f.type || ''));
    if (!list.length) return;
    setFailures([]);
    setProgress({ done: 0, total: list.length, failed: 0 });
    const r = await uploadPhotos(api, list, folder, { onProgress: setProgress });
    if (r.ok.length) addPhotos(r.ok);
    setFailures(r.failed);
    setProgress(null);
    if (r.ok.length) {
      addToast(`${plural(r.ok.length, 'photo')} added${r.failed.length ? `, ${r.failed.length} didn’t upload` : ''}.`, r.failed.length ? 'info' : 'success');
      afterUpload?.(r.ok.length);
    } else if (r.failed.length) {
      addToast('None of the photos uploaded. See the list below.', 'error');
    }
  };

  const setHighlight = (i, field, value) => {
    const next = Array.from({ length: Math.max(highlights.length, i + 1) }, (_, j) => ({ value: '', label: '', ...(highlights[j] || {}) }));
    next[i] = { ...next[i], [field]: value };
    onEvent('highlights', next);
  };
  const dropHighlight = (i) => onEvent('highlights', highlights.filter((_, j) => j !== i));

  return html`
    <div class="er">
      <div class=${`er-status ${over ? 'is-over' : ''}`}>
        <span class="er-status__dot" aria-hidden="true"></span>
        <div class="er-status__text">
          ${over ? html`
            <strong>${displayName(ev)} ${yearOf(ev)} is over, so its page is the thank-you.</strong>
            <span>${newest
              ? html`Since the morning after ${day}, <a href=${path} target="_blank" rel="noopener">${path}</a> shows the photos, then the sponsors. No tickets or countdown.`
              : html`It has its own page for good: <a href=${year || path} target="_blank" rel="noopener">${year || path}</a>.`}
              ${series && newest ? html` It also has a page that never moves: <a href=${year} target="_blank" rel="noopener">${year}</a>.` : null}
              ${series && !newest && !ev.recapSaved ? html` Its photos and sponsors are copied here from the ${kind} page within 15 minutes of next year’s being added.` : null}</span>
          ` : html`
            <strong>Before the ${kind}, the page sells tickets.</strong>
            <span>From the morning after ${day || 'the event'}, <a href=${path} target="_blank" rel="noopener">${path}</a> turns into the thank-you by itself: the photos, then the sponsors. Nothing to publish.</span>
          `}
        </div>
      </div>

      <div class="er-counts">
        <div class="er-count">
          <span class="er-count__n">${photos.length}</span>
          <span class="er-count__l">${photos.length === 1 ? 'photo' : 'photos'} on the page</span>
          <span class="er-count__how">${!photos.length
            ? (over ? 'It says the photos are on the way.' : 'Add them after the event.')
            : (ev.photos || []).some((p) => p?.id) ? 'This event’s own photos.' : `From the Gallery tab, the ones added after ${fmtDay(ev.date, { month: 'short', day: 'numeric' })}.`}</span>
        </div>
        <div class="er-count">
          <span class="er-count__n">${nSponsors}</span>
          <span class="er-count__l">${nSponsors === 1 ? 'sponsor' : 'sponsors'} thanked</span>
          <span class="er-count__how">${!nSponsors ? 'None listed yet.' : cleanSponsors(ev.sponsors).length ? 'This event’s own list.' : 'From the Sponsors tab.'}</span>
        </div>
      </div>

      <section class="er-block">
        <h3>The photographer’s photos</h3>
        <p class="er-hint">${inGallery
          ? html`They go in the Gallery tab and show on the ${kind}’s page in the order there. Photos added after ${fmtDay(ev.date, { month: 'long', day: 'numeric' })} belong to this ${kind}; when next year’s is added, this year keeps them on <a href=${year || path} target="_blank" rel="noopener">${year || 'its own page'}</a>.`
          : 'They go in Event Photos above and show on the event’s page in that order, first one on top.'}</p>
        <${PhotoDrop} onFiles=${upload} busy=${!!progress} label=${progress ? `Uploading ${progress.done} of ${progress.total}…` : 'Add the photos'} />
        ${progress ? html`<div class="er-progress" role="progressbar" aria-valuemin="0" aria-valuemax=${progress.total} aria-valuenow=${progress.done}><span style=${`width:${Math.round((progress.done / progress.total) * 100)}%`}></span></div>` : null}
        ${failures.length ? html`
          <div class="er-fail" role="alert">
            <strong>${plural(failures.length, 'photo')} didn’t upload</strong>
            <ul>${failures.slice(0, 8).map((f) => html`<li>${f.file.name}: ${f.error}</li>`)}</ul>
            ${failures.length > 8 ? html`<p>…and ${failures.length - 8} more.</p>` : null}
            <button type="button" class="btn btn-secondary btn-sm" onClick=${() => upload(failures.map((f) => f.file))}>Try those again</button>
          </div>` : null}
        <div class="er-row">
          <label class="form-group">
            <span class="form-label">Photos by</span>
            <input class="form-input" value=${ev.photographer || ''} placeholder="The photographer’s name or studio" onInput=${(e) => onEvent('photographer', e.target.value)} />
            <span class="form-hint">Shown under the photos and in the viewer.</span>
          </label>
          <label class="form-group">
            <span class="form-label">Their website <span class="label-note">(optional)</span></span>
            <input class="form-input" type="url" value=${ev.photographerUrl || ''} placeholder="https://" onInput=${(e) => onEvent('photographerUrl', e.target.value)} />
          </label>
        </div>
      </section>

      <section class="er-block">
        <h3>The thank-you</h3>
        <label class="form-group">
          <span class="form-label">Thank-you note <span class="label-note">(optional, the words at the top of the page)</span></span>
          <textarea class="form-textarea" rows="3" value=${ev.recapNote || ''} placeholder=${recapLead({ ...ev, recapNote: '' }, { photos: photos.length, sponsors: nSponsors })}
            onInput=${(e) => onEvent('recapNote', e.target.value)} />
          <span class="form-hint">Leave it empty to use the words in gray, which change by themselves as photos and sponsors are added.</span>
        </label>
        <div class="form-group">
          <span class="form-label">The ${when}’s numbers <span class="label-note">(optional, up to ${HIGHLIGHTS_MAX}, shown under the note)</span></span>
          ${highlights.map((hl, i) => html`
            <div class="er-hl">
              <input class="form-input er-hl__v" value=${hl.value || ''} placeholder="350" aria-label=${`Number ${i + 1}`} onInput=${(e) => setHighlight(i, 'value', e.target.value)} />
              <input class="form-input" value=${hl.label || ''} placeholder="Guests" aria-label=${`What number ${i + 1} counts`} onInput=${(e) => setHighlight(i, 'label', e.target.value)} />
              <button type="button" class="btn btn-ghost btn-sm" aria-label=${`Remove number ${i + 1}`} onClick=${() => dropHighlight(i)}>✕</button>
            </div>`)}
          ${highlights.length < HIGHLIGHTS_MAX ? html`<button type="button" class="btn btn-ghost btn-sm er-add" onClick=${() => setHighlight(highlights.length, 'value', '')}>+ Add a number</button>` : null}
          ${cleanHighlights(highlights).length < highlights.filter((x) => x.value || x.label).length ? html`<span class="form-hint">A number shows once it has both parts.</span>` : null}
        </div>
      </section>
    </div>`;
}

/** An event's own sponsor list: tiers and names (logos stay as they are) */
export function SponsorsList({ value, onChange }) {
  injectStyles();
  const tiers = Array.isArray(value) ? value : [];
  const set = (fn) => onChange(fn(tiers.map((t) => ({ ...t, names: [...(t.names || [])] }))));
  return html`
    <div class="er-sp">
      ${tiers.map((t, ti) => html`
        <div class="er-sp__tier">
          <div class="er-sp__head">
            <input class="form-input" value=${t.tier || ''} placeholder="Gold Sponsor" aria-label="Level" onInput=${(e) => set((x) => { x[ti].tier = e.target.value; return x; })} />
            <select class="form-select" value=${t.size || 'md'} aria-label="Logo size" onChange=${(e) => set((x) => { x[ti].size = e.target.value; return x; })}>
              <option value="xl">Top level</option><option value="lg">Large</option><option value="md">Standard</option><option value="sm">Named moment</option>
            </select>
            <button type="button" class="btn btn-ghost btn-sm" onClick=${() => set((x) => x.filter((_, j) => j !== ti))}>Remove level</button>
          </div>
          ${(t.names || []).map((n, ni) => html`
            <div class="er-sp__name">
              ${n.logo ? html`<img src=${`https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/${String(n.logo).replace(/^https?:\/\/[^/]+\/(cdn-cgi\/imagedelivery\/)?[^/]+\//, '').replace(/\/(public|w=.*)$/, '')}/trim=border,w=120,h=60,fit=contain`} alt="" />` : html`<span class="er-sp__nologo">No logo</span>`}
              <input class="form-input" value=${n.name || ''} aria-label="Sponsor name" onInput=${(e) => set((x) => { x[ti].names[ni] = { ...x[ti].names[ni], name: e.target.value }; return x; })} />
              <button type="button" class="btn btn-ghost btn-sm" aria-label=${`Remove ${n.name || 'sponsor'}`} onClick=${() => set((x) => { x[ti].names.splice(ni, 1); return x; })}>✕</button>
            </div>`)}
          <button type="button" class="btn btn-ghost btn-sm er-add" onClick=${() => set((x) => { x[ti].names.push({ name: '' }); return x; })}>+ Add a sponsor</button>
        </div>`)}
      <button type="button" class="btn btn-secondary btn-sm" onClick=${() => onChange([...tiers, { tier: '', size: 'md', names: [{ name: '' }] }])}>+ Add a level</button>
    </div>`;
}

/** What the tournament page reads from its event: name, date, time, place, registration link */
export function EventBasics({ event, onEvent }) {
  injectStyles();
  const ev = event || {};
  const field = (key, label, attrs = {}) => html`
    <label class="form-group">
      <span class="form-label">${label}</span>
      <input class="form-input" value=${ev[key] || ''} onInput=${(e) => onEvent(key, e.target.value)} ...${attrs} />
    </label>`;
  return html`
    <div class="er-row">
      ${field('title', 'Title', { placeholder: 'Sunshine on a Ranney Fairway' })}
      ${field('date', 'Date', { type: 'date' })}
      ${field('time', 'Time', { placeholder: '7:00 AM' })}
      ${field('location', 'Course', { placeholder: 'Indian Hills Country Club' })}
      ${field('address', 'Address', { placeholder: '4001 Clubland Dr. Marietta, GA 30068' })}
      ${field('ticketUrl', 'Registration link', { type: 'url', placeholder: 'https://www.zeffy.com/…' })}
    </div>
    <label class="checkbox-label u-mt-1" style="display: inline-flex; align-items: center; gap: 0.5rem;">
      <input type="checkbox" checked=${!!ev.featured} onChange=${(e) => onEvent('featured', e.target.checked)} />
      Featured event <span class="label-note">(hero spot on the events page)</span>
    </label>`;
}
