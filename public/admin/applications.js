/**
 * Admin → Applications (loaded on first visit, like ./automations.js)
 * ===========================================================================
 * Four tabs over functions/api/applications-admin.js:
 *  - Applications: each submission and whether it reached JobTread (Retry,
 *    a test application, recent status messages). Staff review in JobTread.
 *  - Form: the application itself. Pages and questions on the left, the
 *    selected one on the right, a phone preview on demand. Every change saves
 *    to a draft; "Put live" makes it what families see, right away. Questions
 *    that feed JobTread can be reworded and moved, never removed.
 *  - Messages: the JobTread messages families get (Application Status, In
 *    Review, Approved, Denied), part of the same draft.
 *  - History: every version that went live; restore one into the draft.
 *
 * The definition format and its rules are functions/api/_application-form.js.
 */

import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';

const html = htm.bind(h);
const API = '/api/applications-admin';

const SERVICE_MAP_IMAGE = 'd993cd7c-7863-4a1b-ea5e-50602623cb00';
const CF_BASE = '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ';
const CHOICE_TYPES = ['select', 'radio', 'checkbox', 'ack'];
const ANSWERED = (t) => !['content', 'image', 'guidelines'].includes(t);
const ADDABLE = ['text', 'textarea', 'radio', 'checkbox', 'select', 'date', 'email', 'phone', 'name', 'address', 'ack', 'photo', 'content', 'image'];
const SAMPLE = { parent: 'Jordan Stone', child: 'Avery Stone' };

const clone = (o) => JSON.parse(JSON.stringify(o));
const choice = (o) => (o && typeof o === 'object' ? { value: String(o.value ?? o.label ?? ''), label: String(o.label || o.value || ''), description: o.description || '' } : { value: String(o ?? ''), label: String(o ?? ''), description: '' });
const packChoice = (c) => (c.label && c.label !== c.value) || c.description ? { value: c.value, ...(c.label && c.label !== c.value ? { label: c.label } : {}), ...(c.description ? { description: c.description } : {}) } : c.value;
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const fill = (s, year) => String(s || '').replace(/\{year\}/g, year || '2027');

async function call(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  return j;
}

// ─── Styles (prefixed afe-, injected once) ────────────────────────
const CSS = `
.afe-tabs { margin-bottom: 1rem; }
.afe-bar { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; justify-content: space-between; padding: .85rem 1rem; margin-bottom: 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); position: sticky; top: 0; z-index: 20; box-shadow: var(--shadow-xs); }
.afe-bar-text { display: grid; gap: .15rem; min-width: 0; }
.afe-bar-text strong { font-size: .95rem; }
.afe-bar-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.afe-problems { border: 1px solid #E8B4B4; background: var(--color-danger-bg); border-radius: var(--radius-md); padding: .75rem 1rem; margin-bottom: 1rem; }
.afe-problems ul { margin: .35rem 0 0 1.1rem; }
.afe-problems li { margin: .2rem 0; font-size: .9rem; }
.afe-problems button { background: none; border: 0; padding: 0; color: var(--color-info); text-decoration: underline; cursor: pointer; font: inherit; }
.afe-cols { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(320px, 1fr); gap: 1rem; align-items: start; }
.afe-cols.has-preview { grid-template-columns: minmax(280px, 1fr) minmax(300px, 1fr) 400px; }
@media (max-width: 1100px) { .afe-cols, .afe-cols.has-preview { grid-template-columns: 1fr; } }
.afe-col { display: grid; gap: .75rem; min-width: 0; }
.afe-col > *, .afe-rows, .afe-row { min-width: 0; }
.afe-panel { min-width: 0; overflow: hidden; }
.afe-panel { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); padding: .9rem; }
.afe-inspector { position: sticky; top: 76px; max-height: calc(100vh - 96px); overflow: auto; }
@media (max-width: 1100px) { .afe-inspector { position: static; max-height: none; } }
.afe-page-head { display: flex; align-items: center; gap: .5rem; justify-content: space-between; margin-bottom: .5rem; }
.afe-page-head button.afe-title { flex: 1; text-align: left; font-weight: 700; font-size: 1rem; background: none; border: 0; padding: .25rem .2rem; cursor: pointer; border-radius: 6px; color: var(--color-text); }
.afe-page-head button.afe-title:hover, .afe-page-head button.afe-title.is-sel { background: var(--color-primary-bg); }
.afe-num { color: var(--color-text-muted); font-weight: 600; font-size: .8rem; margin-right: .35rem; }
.afe-rows { display: grid; gap: .35rem; }
.afe-row { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem .5rem; border: 1px solid var(--color-border); border-radius: 10px; padding: .45rem .55rem; background: var(--color-bg-secondary); cursor: pointer; text-align: left; width: 100%; font: inherit; color: inherit; }
.afe-row:hover { border-color: var(--color-border-strong); }
.afe-row.is-sel { border-color: var(--color-primary); box-shadow: 0 0 0 2px var(--color-primary-ring); background: #fff; }
.afe-row.has-problem { border-color: #E8B4B4; }
.afe-type { flex-shrink: 0; font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--color-text-muted); min-width: 5.5rem; }
.afe-row-label { flex: 1 1 12rem; min-width: 8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .9rem; }
.afe-row-badges { display: flex; gap: .25rem; flex-shrink: 0; }
.afe-mini { display: flex; gap: .15rem; flex-shrink: 0; }
.afe-mini button { width: 30px; height: 30px; border: 1px solid var(--color-border); background: #fff; border-radius: 7px; cursor: pointer; font-size: .85rem; color: var(--color-text-secondary); }
.afe-mini button:disabled { opacity: .35; cursor: default; }
.afe-add { margin-top: .5rem; display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; }
.afe-add select { max-width: 220px; }
.afe-field { display: grid; gap: .3rem; margin-bottom: .85rem; }
.afe-field > label, .afe-field > .afe-label { font-weight: 600; font-size: .85rem; }
.afe-hint { font-size: .8rem; color: var(--color-text-muted); }
.afe-lock { border: 1px solid var(--color-border); background: var(--color-primary-bg); border-radius: 10px; padding: .55rem .7rem; font-size: .85rem; margin-bottom: .85rem; }
.afe-choice { display: grid; grid-template-columns: 1fr auto; gap: .35rem; border: 1px solid var(--color-border); border-radius: 10px; padding: .5rem; margin-bottom: .4rem; }
.afe-choice-main { display: grid; gap: .3rem; min-width: 0; }
.afe-check { display: flex; align-items: center; gap: .5rem; font-size: .9rem; cursor: pointer; }
.afe-check input { width: 18px; height: 18px; }
.afe-pick { display: flex; flex-wrap: wrap; gap: .35rem .9rem; }
.afe-preview { position: sticky; top: 76px; }
.afe-preview iframe { width: 100%; height: calc(100vh - 140px); min-height: 560px; border: 1px solid var(--color-border); border-radius: 18px; background: #fff; }
.afe-msg { display: grid; gap: .5rem; margin-bottom: 1.25rem; }
.afe-msg textarea { min-height: 200px; font-family: inherit; line-height: 1.5; }
.afe-msg-preview { white-space: pre-wrap; font-size: .9rem; background: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 10px; padding: .75rem; line-height: 1.5; }
.afe-chips { display: flex; gap: .35rem; flex-wrap: wrap; }
.afe-chips button { border: 1px solid var(--color-border); background: #fff; border-radius: 999px; padding: .15rem .6rem; font-size: .8rem; cursor: pointer; font-family: ui-monospace, monospace; }
.afe-empty { color: var(--color-text-muted); font-size: .9rem; padding: .5rem 0; }
.afe-danger { color: var(--color-danger); }
`;
function useStyles() {
  useEffect(() => {
    if (document.getElementById('afe-style')) return;
    const s = document.createElement('style');
    s.id = 'afe-style';
    s.textContent = CSS;
    document.head.append(s);
  }, []);
}

// ─── The area ──────────────────────────────────────────────────────
export function ApplicationsArea({ addToast, RichTextEditor = null, initialTab = null }) {
  useStyles();
  const hashId = (location.hash.match(/^#applications\/([\w-]+)/) || [])[1] || null;
  const [tab, setTab] = useState(initialTab || (/^#applications\/(form|messages|history)$/.test(location.hash) ? location.hash.split('/')[1] : 'list'));
  const draft = useFormDraft(addToast);
  const go = (t) => { setTab(t); history.replaceState(null, '', t === 'list' ? '#applications' : `#applications/${t}`); };
  return html`
    <div class="hub-tabs afe-tabs">
      ${[['list', 'Applications'], ['form', 'Form'], ['messages', 'Messages'], ['history', 'History']].map(([k, label]) => html`
        <button class="hub-tab ${tab === k ? 'active' : ''}" onClick=${() => go(k)}>${label}</button>`)}
    </div>
    ${tab === 'list' && html`<${AppsList} addToast=${addToast} openFirst=${hashId && !['form', 'messages', 'history'].includes(hashId) ? hashId : null} />`}
    ${tab === 'form' && html`<${FormEditor} d=${draft} RichTextEditor=${RichTextEditor} addToast=${addToast} />`}
    ${tab === 'messages' && html`<${MessagesEditor} d=${draft} />`}
    ${tab === 'history' && html`<${HistoryTab} d=${draft} addToast=${addToast} />`}
  `;
}

// ─── Applications list ─────────────────────────────────────────────
function AppsList({ addToast, openFirst }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [openId, setOpenId] = useState(openFirst);
  const [detail, setDetail] = useState(null);

  const load = async () => {
    const j = await call(API);
    if (j.success) { setData(j); setError(null); } else setError(j.error || 'Could not load');
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!openId) { setDetail(null); return undefined; }
    let live = true;
    call(`${API}?id=${encodeURIComponent(openId)}`).then(j => { if (live) setDetail(j.success ? j.application : { error: j.error }); });
    return () => { live = false; };
  }, [openId]);

  const post = async (body, label) => {
    setBusy(label);
    const j = await call(API, body);
    setBusy('');
    if (!j.success) addToast(j.error || 'That didn’t work', 'error');
    await load();
    return j.success ? j : null;
  };
  const retry = async (id) => {
    const j = await post({ retry: id }, id);
    if (j) addToast(j.result?.status === 'done' ? 'Everything is in JobTread.' : j.result?.status === 'waiting' ? 'In JobTread; still waiting on the video.' : `Still not finished: ${j.result?.error || j.result?.status}`, j.result?.error ? 'error' : 'success');
    if (openId === id) { setOpenId(null); setTimeout(() => setOpenId(id), 0); }
  };
  const sendTest = async () => {
    const j = await post({ test: true }, 'test');
    if (j) addToast(j.result?.status === 'error' ? `Test made but not finished: ${j.result.error}` : 'Test application sent to JobTread as "TEST Applicant". Archive that account when you are done.', j.result?.status === 'error' ? 'error' : 'success');
  };

  const CHECKS = [['account', 'Account'], ['contacts', 'Contacts'], ['home', 'Home'], ['pdf', 'PDF'], ['photos', 'Photos'], ['video', 'Video'], ['familyMessage', 'Family message'], ['medicalNote', 'Medical note'], ['staffEmail', 'Staff email']];
  const chip = (label, v) => {
    const cls = v === true ? 'badge-green' : v === 'none' ? 'badge-gray' : v === 'waiting' ? 'badge-yellow' : v === false ? 'badge-gray' : 'badge-red';
    const mark = v === true ? '✓' : v === 'waiting' ? '…' : v === 'none' ? '–' : v === false ? '·' : '!';
    return html`<span class="badge ${cls}" title=${typeof v === 'string' && v !== 'none' && v !== 'waiting' ? v : ''}>${mark} ${label}</span>`;
  };
  const apps = data?.applications || [];

  return html`
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap;">
        <div style="max-width: 60rem;">
          <h3 class="u-mb-1">Applications</h3>
          <p class="text-sm text-muted mb-1">Families apply at <a href="/apply/form/" target="_blank" style="color: var(--color-primary-ink); text-decoration: underline;">/apply/form/</a>. Each one goes straight into JobTread as a customer account with the PDF, photos and video, and the family gets the "Application Status" message from the Qualification Committee. Review them in JobTread; this list shows whether each one arrived.</p>
          ${data && html`<p class="text-sm" style="margin: 0;">
            Applications are <strong>${data.open ? 'open' : 'closed'}</strong> for the ${data.year} season.
            <span class="text-muted"> Change that in Site Config → Settings → Makeover Application.</span>
          </p>`}
        </div>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <button class="btn btn-ghost" onClick=${load} disabled=${!!busy}>Refresh</button>
          <button class="btn btn-ghost" onClick=${sendTest} disabled=${!!busy}>${busy === 'test' ? 'Sending…' : 'Send test application'}</button>
        </div>
      </div>
      ${error && html`<p class="text-sm afe-danger">Couldn't load applications: ${error}</p>`}
      ${data && html`
        <p class="text-sm text-muted" style="margin: 0.75rem 0;">
          ${data.draftsInProgress} in progress (not submitted yet)
          · Messages post as ${data.qcGrant ? 'Qualification Committee' : html`<strong>the site's connection</strong> (add the Qualification Committee's JobTread key as JOBTREAD_QC_GRANT_KEY in Cloudflare to post as them)`}
          ${!data.stream && html` · <strong>Video uploads are not set up</strong> (CF_STREAM_TOKEN)`}
        </p>
        ${apps.length === 0 ? html`<p class="afe-empty">No applications yet.</p>` : html`
          <div style="display: grid; gap: 0.6rem;">
            ${apps.map(a => html`
              <div style="border: 1px solid var(--color-border); border-radius: 10px; padding: 0.75rem 0.9rem; ${openId === a.id ? 'box-shadow: 0 0 0 2px var(--color-primary);' : ''}">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
                  <div style="min-width: 0;">
                    <strong>${a.child || 'Applicant'}</strong>
                    ${a.isTest && html` <span class="badge badge-blue">TEST</span>`}
                    <span class="text-sm text-muted"> · ${(a.makeoverTypes || []).join(', ')} · ${when(a.submittedAt)}</span>
                  </div>
                  <div style="display: flex; gap: 0.4rem; flex-wrap: wrap;">
                    ${a.jobtreadUrl && html`<a class="btn btn-ghost" href=${a.jobtreadUrl} target="_blank" rel="noopener">Open in JobTread</a>`}
                    ${a.status !== 'done' && html`<button class="btn btn-ghost" onClick=${() => retry(a.id)} disabled=${!!busy}>${busy === a.id ? 'Retrying…' : 'Retry now'}</button>`}
                    <button class="btn btn-ghost" aria-expanded=${openId === a.id} onClick=${() => { const next = openId === a.id ? null : a.id; setOpenId(next); history.replaceState(null, '', next ? `#applications/${next}` : '#applications'); }}>${openId === a.id ? 'Hide' : 'Details'}</button>
                  </div>
                </div>
                <div style="display: flex; gap: 0.35rem; flex-wrap: wrap; margin-top: 0.5rem;">
                  ${CHECKS.map(([k, label]) => chip(label, a.checklist?.[k]))}
                </div>
                ${a.status === 'error' && html`<p class="text-sm afe-danger" style="margin: 0.5rem 0 0;">Not finished after ${a.attempts} ${a.attempts === 1 ? 'try' : 'tries'}: ${a.lastError}. It retries on its own.</p>`}
                ${a.status === 'waiting' && html`<p class="text-sm text-muted" style="margin: 0.5rem 0 0;">Waiting on Cloudflare to finish processing the video; it's attached automatically.</p>`}
                ${openId === a.id && html`
                  <div style="margin-top: 0.75rem; border-top: 1px solid var(--color-border); padding-top: 0.75rem;">
                    ${!detail ? html`<p class="text-sm text-muted">Loading…</p>` : detail.error ? html`<p class="text-sm">${detail.error}</p>` : html`
                      <p class="text-sm" style="margin: 0 0 0.5rem;">
                        ${detail.parent} · <a href=${`mailto:${detail.email}`}>${detail.email}</a>
                        ${detail.hasPdf && html` · <a href=${`${API}?file=${detail.id}&field=pdf`} target="_blank">Application PDF</a>`}
                        <span class="text-muted"> · form version ${detail.formVersion || 'built in'}</span>
                      </p>
                      ${detail.sections.map(s => html`
                        <details style="margin: 0.35rem 0;">
                          <summary style="cursor: pointer; font-weight: 600;">${s.title}</summary>
                          <dl style="margin: 0.4rem 0 0.4rem 0.75rem;">
                            ${s.items.map(i => html`
                              <dt class="text-sm text-muted" style="margin-top: 0.4rem;">${i.label}</dt>
                              <dd style="margin: 0; white-space: pre-wrap;">${i.upload
                                ? (i.type === 'photo' ? html`<a href=${`${API}?file=${detail.id}&field=${i.id}`} target="_blank"><img src=${`${API}?file=${detail.id}&field=${i.id}${i.hasThumb ? '&thumb=1' : ''}`} alt=${i.label} style="max-width: 160px; max-height: 120px; border-radius: 6px;" /></a>` : `Video ${i.video?.uploaded ? 'uploaded' : 'not finished'}${i.video?.duration ? ` (${Math.round(i.video.duration)} s)` : ''}`)
                                : i.text}</dd>`)}
                          </dl>
                        </details>`)}
                    `}
                  </div>`}
              </div>`)}
          </div>`}
        ${(data.events || []).length > 0 && html`
          <details style="margin-top: 1rem;">
            <summary class="text-sm" style="cursor: pointer; font-weight: 600;">Status messages from JobTread (last ${data.events.length})</summary>
            <p class="text-sm text-muted" style="margin: 0.4rem 0;">When someone changes an applicant's Status in JobTread, the site posts the matching message (In Review, Approved, Denied) to the family once. The wording is in the Messages tab.</p>
            <div style="display: grid; gap: 0.25rem;">
              ${data.events.map(e => html`
                <div class="text-sm" style="display: flex; gap: 0.6rem; flex-wrap: wrap;">
                  <span class="text-muted">${when(e.created_at)}</span>
                  <span>${e.previous_status || '—'} → ${e.status || '—'}</span>
                  <span class="text-muted">${Object.entries(e.actions || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'nothing to send'}</span>
                  ${e.error && html`<span class="afe-danger">${e.error}</span>`}
                </div>`)}
            </div>
          </details>`}
      `}
    </div>`;
}

// ─── The draft (shared by Form, Messages, History) ─────────────────
function useFormDraft(addToast) {
  const [meta, setMeta] = useState(null);       // { live, draft, versions, locked, types, year }
  const [work, setWork] = useState(null);       // the definition being edited
  const [problems, setProblems] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | pending | saving | saved | error
  const [savedAt, setSavedAt] = useState(null);
  const [previewKey, setPreviewKey] = useState(0);
  const timer = useRef(null);
  const pending = useRef(null);

  const load = async () => {
    const j = await call(`${API}?form=1`);
    if (!j.success) { addToast(j.error || 'Could not load the form', 'error'); return; }
    setMeta(j);
    setWork(clone(j.draft?.definition || j.live.definition));
    setProblems(j.problems || []);
    setSavedAt(j.draft?.updatedAt || null);
    setStatus('idle');
  };
  useEffect(() => { load(); }, []);

  const save = async (def) => {
    pending.current = null;
    setStatus('saving');
    const j = await call(API, { formSave: def });
    if (!j.success) { setStatus('error'); addToast(j.error || 'Could not save the draft', 'error'); return false; }
    setProblems(j.problems || []);
    setStatus('saved');
    setSavedAt(new Date().toISOString());
    setMeta(m => ({ ...m, draft: { ...(m.draft || {}), version: j.version, definition: j.definition } }));
    setPreviewKey(k => k + 1);
    return true;
  };
  const flush = async () => {
    clearTimeout(timer.current);
    if (pending.current) return save(pending.current);
    return true;
  };
  // Save when leaving the page with changes still waiting
  useEffect(() => {
    const out = () => { if (pending.current) { const body = JSON.stringify({ formSave: pending.current }); navigator.sendBeacon?.(API, new Blob([body], { type: 'application/json' })); } };
    window.addEventListener('pagehide', out);
    return () => { window.removeEventListener('pagehide', out); clearTimeout(timer.current); if (pending.current) save(pending.current); };
  }, []);

  const update = (fn) => {
    setWork((w) => {
      const next = clone(w);
      fn(next);
      pending.current = next;
      setStatus('pending');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => save(next), 900);
      return next;
    });
  };

  const putLive = async () => {
    if (!(await flush())) return;
    if (!confirm('Put these changes live? Families will see them right away. Applications already submitted keep the version they were answered on.')) return;
    const j = await call(API, { formPutLive: true });
    if (!j.success) { addToast(j.error || 'Could not put it live', 'error'); if (j.problems) setProblems(j.problems); return; }
    addToast(`Version ${j.version} is live.`, 'success');
    await load();
  };
  const discard = async () => {
    clearTimeout(timer.current);
    pending.current = null;
    if (!confirm('Throw away the changes that aren’t live yet?')) return;
    await call(API, { formDiscard: true });
    addToast('Changes discarded.', 'success');
    await load();
  };
  const restore = async (v) => {
    await flush();
    if (meta?.draft && !confirm('Replace the changes you haven’t put live with this version?')) return;
    const j = await call(API, { formRestore: v });
    if (!j.success) { addToast(j.error || 'Could not restore it', 'error'); return; }
    addToast(`${v ? `Version ${v}` : 'The built-in form'} is now your draft. Look it over, then put it live.`, 'success');
    await load();
  };

  // Values each choice question has in the live form: those never change (answers point at them)
  const liveValues = useMemo(() => {
    const out = {};
    for (const p of meta?.live?.definition?.pages || []) for (const f of p.fields || []) if (f.options) out[f.id] = new Set(f.options.map(o => choice(o).value));
    return out;
  }, [meta]);

  const hasDraft = !!meta?.draft || status === 'pending' || status === 'saving';
  return { meta, work, problems, status, savedAt, previewKey, update, putLive, discard, restore, flush, hasDraft, liveValues, year: meta?.year || '2027' };
}

function DraftBar({ d, onPreview, previewOn }) {
  const { meta, status, savedAt, problems, hasDraft } = d;
  if (!meta) return null;
  const saving = status === 'pending' || status === 'saving';
  const liveText = meta.live.builtIn ? 'the built-in form' : `version ${meta.live.version}`;
  return html`
    <div class="afe-bar">
      <div class="afe-bar-text">
        ${hasDraft
          ? html`<strong>You have changes that aren't live yet</strong>
              <span class="text-sm text-muted">${saving ? 'Saving…' : status === 'error' ? 'Not saved; it will try again on your next change.' : `Draft saved ${when(savedAt)}`} · families still see ${liveText}</span>`
          : html`<strong>Families see ${liveText}</strong>
              <span class="text-sm text-muted">${meta.live.liveAt ? `Put live ${when(meta.live.liveAt)}${meta.live.liveBy ? ` by ${meta.live.liveBy}` : ''}` : 'Matches the Jotform application for 2027'}. Any change you make is saved as a draft until you put it live.</span>`}
      </div>
      <div class="afe-bar-actions">
        ${onPreview && html`<button class="btn btn-ghost" aria-pressed=${!!previewOn} onClick=${onPreview}>${previewOn ? 'Hide preview' : 'Preview'}</button>`}
        ${hasDraft && html`<a class="btn btn-ghost" href="/apply/form/?preview=draft" target="_blank" rel="noopener" onClick=${() => d.flush()}>Open preview in a new tab</a>`}
        ${hasDraft && html`<button class="btn btn-ghost" onClick=${d.discard}>Discard changes</button>`}
        ${hasDraft && html`<button class="btn btn-primary" disabled=${saving || problems.length > 0} title=${problems.length ? 'Fix the problems listed first' : ''} onClick=${d.putLive}>Put live</button>`}
      </div>
    </div>`;
}

function Problems({ problems, onJump }) {
  if (!problems.length) return null;
  return html`
    <div class="afe-problems" role="alert">
      <strong>${problems.length === 1 ? '1 thing to fix' : `${problems.length} things to fix`} before this can go live</strong>
      <ul>${problems.map(p => html`<li>${p.where && onJump ? html`<button onClick=${() => onJump(p.where)}>${p.where}</button>: ` : ''}${p.message}</li>`)}</ul>
    </div>`;
}

// ─── Form editor ───────────────────────────────────────────────────
function FormEditor({ d, RichTextEditor, addToast }) {
  const { work, meta } = d;
  const [sel, setSel] = useState({ kind: 'page', page: 0 });
  const [preview, setPreview] = useState(false);
  if (!work || !meta) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;
  const locked = meta.locked || {};
  const types = meta.types || {};
  const year = d.year;
  const problemFor = (where) => d.problems.some(p => p.where === where);

  const jump = (where) => {
    if (where.startsWith('stops/')) { setSel({ kind: 'stop', key: where.slice(6) }); return; }
    if (where.startsWith('messages/')) { addToast('That one is in the Messages tab.', 'info'); return; }
    if (where === 'staffEmails') { setSel({ kind: 'settings' }); return; }
    const [pid, fid] = where.split('/');
    const pi = work.pages.findIndex(p => p.id === pid);
    if (pi >= 0 && fid) { const fi = work.pages[pi].fields.findIndex(f => f.id === fid); if (fi >= 0) { setSel({ kind: 'field', page: pi, field: fi }); return; } }
    if (pi >= 0) { setSel({ kind: 'page', page: pi }); return; }
    for (let i = 0; i < work.pages.length; i++) { const fi = work.pages[i].fields.findIndex(f => f.id === where); if (fi >= 0) { setSel({ kind: 'field', page: i, field: fi }); return; } }
  };

  const allIds = new Set(work.pages.flatMap(p => p.fields.map(f => f.id)));
  const newId = () => { let id; do id = `q${Math.random().toString(36).slice(2, 8)}`; while (allIds.has(id)); return id; };

  const moveField = (pi, fi, dir) => d.update((w) => {
    const list = w.pages[pi].fields;
    const to = fi + dir;
    if (to < 0 || to >= list.length) return;
    [list[fi], list[to]] = [list[to], list[fi]];
    setSel({ kind: 'field', page: pi, field: to });
  });
  const movePage = (pi, dir) => d.update((w) => {
    const to = pi + dir;
    if (to < 0 || to >= w.pages.length) return;
    [w.pages[pi], w.pages[to]] = [w.pages[to], w.pages[pi]];
    setSel({ kind: 'page', page: to });
  });
  const addField = (pi, type) => d.update((w) => {
    const f = { id: newId(), type };
    if (ANSWERED(type)) f.label = 'New question';
    if (['radio', 'select', 'checkbox'].includes(type)) f.options = ['First choice', 'Second choice'];
    if (type === 'ack') f.options = ['Yes, I agree.'];
    if (type === 'content') f.html = '<p>New text</p>';
    if (type === 'image') Object.assign(f, { image: '', alt: '', width: 938, height: 768 });
    w.pages[pi].fields.push(f);
    setSel({ kind: 'field', page: pi, field: w.pages[pi].fields.length - 1 });
  });
  const addPage = () => d.update((w) => {
    const ids = new Set(w.pages.map(p => p.id));
    let n = w.pages.length + 1;
    while (ids.has(`page-${n}`)) n++;
    // Before the last page (the signature), so it stays last
    const at = Math.max(0, w.pages.length - 1);
    w.pages.splice(at, 0, { id: `page-${n}`, title: 'New page', fields: [{ id: newId(), type: 'content', html: '<p>New text</p>' }] });
    setSel({ kind: 'page', page: at });
  });

  const selField = sel.kind === 'field' ? work.pages[sel.page]?.fields[sel.field] : null;

  return html`
    <div>
      <${DraftBar} d=${d} onPreview=${() => { d.flush(); setPreview(p => !p); }} previewOn=${preview} />
      <${Problems} problems=${d.problems} onJump=${jump} />
      <div class="afe-cols ${preview ? 'has-preview' : ''}">
        <div class="afe-col">
          ${work.pages.map((p, pi) => html`
            <section class="afe-panel" aria-label=${`Page ${pi + 1}: ${fill(p.title, year)}`}>
              <div class="afe-page-head">
                <button class="afe-title ${sel.kind === 'page' && sel.page === pi ? 'is-sel' : ''}" onClick=${() => setSel({ kind: 'page', page: pi })}>
                  <span class="afe-num">Page ${pi + 1}</span>${fill(p.title, year) || 'Untitled page'}
                </button>
                <span class="afe-mini">
                  <button aria-label=${`Move page ${pi + 1} up`} disabled=${pi === 0} onClick=${() => movePage(pi, -1)}>↑</button>
                  <button aria-label=${`Move page ${pi + 1} down`} disabled=${pi === work.pages.length - 1} onClick=${() => movePage(pi, 1)}>↓</button>
                </span>
              </div>
              <div class="afe-rows">
                ${p.fields.map((f, fi) => {
                  const isSel = sel.kind === 'field' && sel.page === pi && sel.field === fi;
                  const label = ANSWERED(f.type) ? fill(f.label, year) : f.type === 'guidelines' ? (f.title || 'Guidelines') : f.type === 'image' ? (f.alt || 'Image') : strip(fill(f.html, year));
                  return html`
                    <div class="afe-row ${isSel ? 'is-sel' : ''} ${problemFor(`${p.id}/${f.id}`) ? 'has-problem' : ''}" role="button" tabindex="0"
                      onClick=${() => setSel({ kind: 'field', page: pi, field: fi })}
                      onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel({ kind: 'field', page: pi, field: fi }); } }}>
                      <span class="afe-type">${types[f.type] || f.type}</span>
                      <span class="afe-row-label">${label || html`<em class="text-muted">No wording yet</em>`}</span>
                      <span class="afe-row-badges">
                        ${locked[f.id] && html`<span class="badge badge-blue" title=${locked[f.id].role}>JobTread</span>`}
                        ${f.required && html`<span class="badge badge-gray">Required</span>`}
                        ${f.showIf && html`<span class="badge badge-yellow" title="Shown only for some answers">If…</span>`}
                        ${f.stops && Object.keys(f.stops).length > 0 && html`<span class="badge badge-gray" title="An answer ends the application">Ends</span>`}
                      </span>
                      <span class="afe-mini" onClick=${(e) => e.stopPropagation()}>
                        <button aria-label="Move up" disabled=${fi === 0} onClick=${() => moveField(pi, fi, -1)}>↑</button>
                        <button aria-label="Move down" disabled=${fi === p.fields.length - 1} onClick=${() => moveField(pi, fi, 1)}>↓</button>
                      </span>
                    </div>`;
                })}
              </div>
              <div class="afe-add">
                <label class="text-sm text-muted" for=${`afe-add-${pi}`}>Add to this page:</label>
                <select id=${`afe-add-${pi}`} class="form-input" style="width: auto;" value="" onChange=${(e) => { if (e.target.value) addField(pi, e.target.value); e.target.value = ''; }}>
                  <option value="">Choose a question type…</option>
                  ${ADDABLE.map(t => html`<option value=${t}>${types[t] || t}</option>`)}
                </select>
              </div>
            </section>`)}
          <div style="display: flex; gap: .5rem; flex-wrap: wrap;">
            <button class="btn btn-ghost" onClick=${addPage}>+ Add a page</button>
          </div>

          <section class="afe-panel">
            <div class="afe-page-head"><strong>Stop screens</strong></div>
            <p class="afe-hint" style="margin-top: 0;">What a family sees when an answer means we can't help this time. Pick them on a question's choices.</p>
            <div class="afe-rows">
              ${Object.entries(work.stops || {}).map(([k, s]) => html`
                <button class="afe-row ${sel.kind === 'stop' && sel.key === k ? 'is-sel' : ''}" onClick=${() => setSel({ kind: 'stop', key: k })}>
                  <span class="afe-type">Stop</span><span class="afe-row-label">${strip(s.body) || s.title}</span>
                </button>`)}
            </div>
            <div class="afe-add"><button class="btn btn-ghost" onClick=${() => d.update((w) => {
              w.stops = w.stops || {};
              let n = 1; while (w.stops[`stop-${n}`]) n++;
              w.stops[`stop-${n}`] = { title: 'Thank you so much for your interest in Sunshine on a Ranney Day.', body: '<p></p>' };
              setSel({ kind: 'stop', key: `stop-${n}` });
            })}>+ Add a stop screen</button></div>
          </section>

          <section class="afe-panel">
            <button class="afe-row ${sel.kind === 'settings' ? 'is-sel' : ''}" onClick=${() => setSel({ kind: 'settings' })}>
              <span class="afe-type">Settings</span><span class="afe-row-label">Who gets the new-application email</span>
            </button>
          </section>
        </div>

        <div class="afe-col">
          <div class="afe-panel afe-inspector">
            ${sel.kind === 'field' && selField && html`<${FieldInspector} key=${`${sel.page}:${sel.field}:${selField.id}`} d=${d} pi=${sel.page} fi=${sel.field} f=${selField} locked=${locked[selField.id]} types=${types} RichTextEditor=${RichTextEditor} onSelect=${setSel} />`}
            ${sel.kind === 'page' && work.pages[sel.page] && html`<${PageInspector} key=${`p${sel.page}`} d=${d} pi=${sel.page} locked=${locked} onSelect=${setSel} />`}
            ${sel.kind === 'stop' && work.stops?.[sel.key] && html`<${StopInspector} key=${`s${sel.key}`} d=${d} k=${sel.key} RichTextEditor=${RichTextEditor} onSelect=${setSel} />`}
            ${sel.kind === 'settings' && html`<${SettingsInspector} d=${d} />`}
            ${((sel.kind === 'field' && !selField) || (sel.kind === 'page' && !work.pages[sel.page]) || (sel.kind === 'stop' && !work.stops?.[sel.key])) && html`<p class="afe-empty">Pick a page or question on the left.</p>`}
          </div>
        </div>

        ${preview && html`
          <div class="afe-preview">
            <iframe key=${d.previewKey} title="Preview of the application as families see it" src=${`/apply/form/?preview=${d.hasDraft ? 'draft' : '1'}&k=${d.previewKey}`}></iframe>
            <p class="afe-hint">This is the draft as a family sees it on a phone. It updates after each save; nothing typed here is saved.</p>
          </div>`}
      </div>
    </div>`;
}

const Field = ({ label, hint, children, id }) => html`
  <div class="afe-field">
    ${label && html`<label for=${id}>${label}</label>`}
    ${children}
    ${hint && html`<span class="afe-hint">${hint}</span>`}
  </div>`;

function PageInspector({ d, pi, locked, onSelect }) {
  const p = d.work.pages[pi];
  const hasLocked = p.fields.some(f => locked[f.id]);
  const set = (k, v) => d.update((w) => { w.pages[pi][k] = v; });
  return html`
    <h3 style="margin-top: 0;">Page ${pi + 1}</h3>
    <${Field} label="Title" id="afe-page-title" hint="Shown above the questions. {year} becomes the season year.">
      <input id="afe-page-title" class="form-input" value=${p.title} onInput=${(e) => set('title', e.target.value)} />
    <//>
    <${Field} label="Page id" id="afe-page-id" hint="Lowercase letters, numbers and dashes. Only used behind the scenes.">
      <input id="afe-page-id" class="form-input" value=${p.id} onInput=${(e) => { const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40); set('id', v); }} />
    <//>
    <p class="afe-hint">${p.fields.length} ${p.fields.length === 1 ? 'item' : 'items'} on this page.</p>
    <button class="btn btn-ghost afe-danger" disabled=${hasLocked || d.work.pages.length === 1}
      title=${hasLocked ? 'This page has questions that feed JobTread; move them to another page first.' : ''}
      onClick=${() => { if (!confirm(`Delete page ${pi + 1} and everything on it?`)) return; d.update((w) => { const ids = new Set(w.pages[pi].fields.map(f => f.id)); w.pages.splice(pi, 1); for (const pg of w.pages) for (const f of pg.fields) if (f.showIf && ids.has(f.showIf.field)) delete f.showIf; }); onSelect({ kind: 'page', page: Math.max(0, pi - 1) }); }}>Delete this page</button>
    ${hasLocked && html`<p class="afe-hint">This page has questions that feed JobTread. Move them to another page to delete it.</p>`}`;
}

function FieldInspector({ d, pi, fi, f, locked, types, RichTextEditor, onSelect }) {
  const { work, year } = d;
  const up = (fn) => d.update((w) => fn(w.pages[pi].fields[fi], w));
  const id = (k) => `afe-f-${k}`;
  const liveVals = d.liveValues[f.id] || new Set();
  const choices = (f.options || []).map(choice);
  const earlier = work.pages.flatMap((p, i) => p.fields.map((x, j) => ({ ...x, at: i * 1000 + j }))).filter(x => x.at < pi * 1000 + fi && CHOICE_TYPES.includes(x.type));
  const parent = f.showIf ? earlier.find(x => x.id === f.showIf.field) : null;
  const typeChoices = locked ? locked.types : Object.keys(types).filter(t => t !== 'guidelines' || f.type === 'guidelines');

  // Rename a choice's value everywhere that points at it (show-if rules, stop screens)
  const renameValue = (w, from, to) => {
    if (from === to) return;
    const me = w.pages[pi].fields[fi];
    if (me.stops && me.stops[from]) { me.stops[to] = me.stops[from]; delete me.stops[from]; }
    for (const pg of w.pages) for (const x of pg.fields) if (x.showIf?.field === f.id) x.showIf.in = x.showIf.in.map(v => (v === from ? to : v));
  };
  const setChoice = (i, patch) => up((me, w) => {
    const list = me.options.map(choice);
    const c = { ...list[i], ...patch };
    // A choice that isn't live yet follows its wording; a live one keeps its saved value
    if ('label' in patch && !liveVals.has(list[i].value)) {
      // Empty while it's being retyped: the problems list asks for wording until it has some
      let v = patch.label.trim();
      if (v) {
        const others = new Set(list.filter((_, j) => j !== i).map(x => x.value));
        let n = 2; const base = v; while (others.has(v)) v = `${base} (${n++})`;
      }
      renameValue(w, list[i].value, v);
      c.value = v;
      c.label = patch.label;
    }
    list[i] = c;
    me.options = list.map(packChoice);
  });
  const moveChoice = (i, dir) => up((me) => { const list = [...me.options]; const to = i + dir; if (to < 0 || to >= list.length) return; [list[i], list[to]] = [list[to], list[i]]; me.options = list; });
  const removeChoice = (i) => up((me, w) => {
    const v = choice(me.options[i]).value;
    me.options = me.options.filter((_, j) => j !== i);
    if (me.stops) delete me.stops[v];
    for (const pg of w.pages) for (const x of pg.fields) if (x.showIf?.field === f.id) x.showIf.in = x.showIf.in.filter(y => y !== v);
  });
  const addChoice = () => up((me) => {
    const vals = new Set((me.options || []).map(o => choice(o).value));
    let n = (me.options || []).length + 1; let v = `Choice ${n}`; while (vals.has(v)) v = `Choice ${++n}`;
    me.options = [...(me.options || []), v];
  });
  const canAddChoice = !locked?.values;
  const canRemoveChoice = (c) => !(locked?.allValues) && !(locked?.values && choices.length <= 1) && !(f.type === 'ack');

  return html`
    <div style="display: flex; justify-content: space-between; align-items: baseline; gap: .5rem;">
      <h3 style="margin-top: 0;">${types[f.type] || f.type}</h3>
      <span class="afe-hint">Saved as ${f.id}</span>
    </div>
    ${locked && html`<div class="afe-lock"><strong>${locked.role}.</strong> You can reword and move this question; it can't be removed${locked.values ? ', and its choices are the ones JobTread knows' : ''}.</div>`}

    ${ANSWERED(f.type) && html`
      <${Field} label="Wording" id=${id('label')} hint="{year} becomes the season year.">
        <textarea id=${id('label')} class="form-input" rows="3" value=${f.label || ''} onInput=${(e) => up((me) => { me.label = e.target.value; })}></textarea>
      <//>
      <${Field} label="Help text (optional)" id=${id('help')} hint="A short note under the question.">
        <input id=${id('help')} class="form-input" value=${f.help || ''} onInput=${(e) => up((me) => { if (e.target.value) me.help = e.target.value; else delete me.help; })} />
      <//>
      <label class="afe-check" style="margin-bottom: .85rem;">
        <input type="checkbox" checked=${!!f.required} disabled=${!!locked?.required} onChange=${(e) => up((me) => { if (e.target.checked) me.required = true; else delete me.required; })} />
        Required${locked?.required ? ' (always, for JobTread)' : ''}
      </label>`}

    ${typeChoices.length > 1 && html`
      <${Field} label="Type" id=${id('type')}>
        <select id=${id('type')} class="form-input" value=${f.type} onChange=${(e) => up((me) => {
          const t = e.target.value;
          me.type = t;
          if (CHOICE_TYPES.includes(t) && !me.options) me.options = t === 'ack' ? ['Yes, I agree.'] : ['First choice', 'Second choice'];
          if (t === 'ack' && me.options?.length > 1) me.options = [me.options[0]];
          if (!CHOICE_TYPES.includes(t)) { delete me.options; delete me.stops; delete me.max; }
          if (t !== 'checkbox') delete me.max;
          if (t === 'content' && !me.html) me.html = `<p>${me.label || ''}</p>`;
          if (ANSWERED(t) && !me.label) me.label = 'New question';
        })}>
          ${typeChoices.map(t => html`<option value=${t}>${types[t] || t}</option>`)}
        </select>
      <//>`}

    ${CHOICE_TYPES.includes(f.type) && html`
      <div class="afe-field">
        <span class="afe-label">${f.type === 'ack' ? 'Checkbox wording' : 'Choices'}</span>
        ${choices.map((c, i) => html`
          <div class="afe-choice">
            <div class="afe-choice-main">
              <input class="form-input" aria-label=${`Choice ${i + 1}`} value=${c.label} onInput=${(e) => setChoice(i, { label: e.target.value })} />
              ${f.type !== 'ack' && f.type !== 'select' && html`<input class="form-input" aria-label=${`Description for choice ${i + 1}`} placeholder="Description (optional)" value=${c.description} onInput=${(e) => setChoice(i, { description: e.target.value })} />`}
              ${c.label !== c.value && html`<span class="afe-hint">Saved as "${c.value}"${locked ? ' (what JobTread gets)' : ''}</span>`}
              ${['radio', 'select'].includes(f.type) && Object.keys(work.stops || {}).length > 0 && html`
                <label class="afe-hint" style="display: flex; gap: .4rem; align-items: center;">This answer
                  <select class="form-input" style="width: auto; padding: .2rem .4rem;" value=${f.stops?.[c.value] || ''} onChange=${(e) => up((me) => { me.stops = { ...(me.stops || {}) }; if (e.target.value) me.stops[c.value] = e.target.value; else delete me.stops[c.value]; if (!Object.keys(me.stops).length) delete me.stops; })}>
                    <option value="">continues the application</option>
                    ${Object.entries(work.stops).map(([k, s]) => html`<option value=${k}>ends it: ${strip(s.body).slice(0, 40) || s.title}</option>`)}
                  </select>
                </label>`}
            </div>
            <span class="afe-mini" style="flex-direction: column;">
              <button aria-label=${`Move choice ${i + 1} up`} disabled=${i === 0} onClick=${() => moveChoice(i, -1)}>↑</button>
              <button aria-label=${`Move choice ${i + 1} down`} disabled=${i === choices.length - 1} onClick=${() => moveChoice(i, 1)}>↓</button>
              ${canRemoveChoice(c) && html`<button aria-label=${`Remove choice ${i + 1}`} onClick=${() => removeChoice(i)}>✕</button>`}
            </span>
          </div>`)}
        ${f.type !== 'ack' && canAddChoice && html`<button class="btn btn-ghost" onClick=${addChoice}>+ Add a choice</button>`}
        ${locked?.values && !locked.allValues && html`<span class="afe-hint">JobTread knows: ${locked.values.join(', ')}. You can reword, reorder or remove these, not add new ones.</span>`}
      </div>`}

    ${f.type === 'checkbox' && html`
      <${Field} label="Most choices a family can pick (optional)" id=${id('max')}>
        <input id=${id('max')} type="number" min="1" max=${choices.length} class="form-input" style="width: 7rem;" value=${f.max || ''} onInput=${(e) => up((me) => { const n = parseInt(e.target.value, 10); if (n > 0) me.max = n; else delete me.max; })} />
      <//>`}

    ${f.type === 'content' && html`
      <div class="afe-field">
        <span class="afe-label">Text</span>
        ${RichTextEditor
          ? html`<${RichTextEditor} value=${f.html || ''} minHeight=${160} label="Text block" onChange=${(v) => up((me) => { me.html = v; })} />`
          : html`<textarea class="form-input" rows="8" value=${f.html || ''} onInput=${(e) => up((me) => { me.html = e.target.value; })}></textarea>`}
        <span class="afe-hint">{year} becomes the season year.</span>
      </div>`}

    ${f.type === 'image' && html`
      <${Field} label="Cloudflare Images id" id=${id('image')} hint="The id of an image already in Cloudflare Images (Media in the admin).">
        <input id=${id('image')} class="form-input" value=${f.image || ''} onInput=${(e) => up((me) => { me.image = e.target.value.trim(); })} />
      <//>
      <${Field} label="Describe the image (for people who can't see it)" id=${id('alt')}>
        <input id=${id('alt')} class="form-input" value=${f.alt || ''} onInput=${(e) => up((me) => { me.alt = e.target.value; })} />
      <//>
      ${f.image && html`<img src=${`${CF_BASE}/${f.image}/w=600`} alt="" style="max-width: 100%; border-radius: 10px; border: 1px solid var(--color-border);" />`}`}

    ${f.type === 'guidelines' && html`<${GuidelinesEditor} f=${f} up=${up} />`}

    ${ANSWERED(f.type) && html`
      <div class="afe-field">
        <span class="afe-label">Show only when…</span>
        <select class="form-input" aria-label="Show only when this question is answered" value=${f.showIf?.field || ''} onChange=${(e) => up((me) => { if (e.target.value) me.showIf = { field: e.target.value, in: [] }; else delete me.showIf; })}>
          <option value="">Always show this question</option>
          ${earlier.map(x => html`<option value=${x.id}>${strip(fill(x.label, year)).slice(0, 70)}</option>`)}
        </select>
        ${parent && html`
          <span class="afe-hint">…the answer is:</span>
          <div class="afe-pick">
            ${(parent.options || []).map(choice).map(c => html`
              <label class="afe-check"><input type="checkbox" checked=${f.showIf.in.includes(c.value)} onChange=${(e) => up((me) => { const s = new Set(me.showIf.in); if (e.target.checked) s.add(c.value); else s.delete(c.value); me.showIf.in = [...s]; })} />${c.label}</label>`)}
          </div>`}
      </div>`}

    <${Field} label="On page" id=${id('page')}>
      <select id=${id('page')} class="form-input" value=${String(pi)} onChange=${(e) => { const to = Number(e.target.value); d.update((w) => { const [me] = w.pages[pi].fields.splice(fi, 1); w.pages[to].fields.push(me); }); onSelect({ kind: 'field', page: to, field: work.pages[to].fields.length }); }}>
        ${work.pages.map((p, i) => html`<option value=${String(i)}>Page ${i + 1}: ${fill(p.title, year)}</option>`)}
      </select>
    <//>

    ${!locked && html`<button class="btn btn-ghost afe-danger" onClick=${() => {
      if (!confirm('Delete this question? Applications already submitted keep their answer.')) return;
      d.update((w) => { w.pages[pi].fields.splice(fi, 1); for (const pg of w.pages) for (const x of pg.fields) if (x.showIf?.field === f.id) delete x.showIf; });
      onSelect({ kind: 'page', page: pi });
    }}>Delete this ${ANSWERED(f.type) ? 'question' : 'item'}</button>`}`;
}

function GuidelinesEditor({ f, up }) {
  return html`
    <${Field} label="Heading" id="afe-g-title"><input id="afe-g-title" class="form-input" value=${f.title || ''} onInput=${(e) => up((me) => { me.title = e.target.value; })} /><//>
    <${Field} label="First list title" id="afe-g-do"><input id="afe-g-do" class="form-input" value=${f.doTitle || ''} onInput=${(e) => up((me) => { me.doTitle = e.target.value; })} /><//>
    ${(f.doItems || []).map((it, i) => html`
      <div class="afe-choice">
        <div class="afe-choice-main">
          <input class="form-input" aria-label=${`Item ${i + 1} title`} placeholder="Title" value=${it.title} onInput=${(e) => up((me) => { me.doItems[i].title = e.target.value; })} />
          <textarea class="form-input" rows="2" aria-label=${`Item ${i + 1} text`} value=${it.text} onInput=${(e) => up((me) => { me.doItems[i].text = e.target.value; })}></textarea>
        </div>
        <span class="afe-mini"><button aria-label=${`Remove item ${i + 1}`} onClick=${() => up((me) => { me.doItems.splice(i, 1); })}>✕</button></span>
      </div>`)}
    <button class="btn btn-ghost" style="margin-bottom: .85rem;" onClick=${() => up((me) => { me.doItems = [...(me.doItems || []), { title: '', text: '' }]; })}>+ Add to the first list</button>
    <${Field} label="Second list title" id="afe-g-dont"><input id="afe-g-dont" class="form-input" value=${f.dontTitle || ''} onInput=${(e) => up((me) => { me.dontTitle = e.target.value; })} /><//>
    ${(f.dontItems || []).map((it, i) => html`
      <div class="afe-choice">
        <div class="afe-choice-main"><input class="form-input" aria-label=${`Second list item ${i + 1}`} value=${it} onInput=${(e) => up((me) => { me.dontItems[i] = e.target.value; })} /></div>
        <span class="afe-mini"><button aria-label=${`Remove second list item ${i + 1}`} onClick=${() => up((me) => { me.dontItems.splice(i, 1); })}>✕</button></span>
      </div>`)}
    <button class="btn btn-ghost" style="margin-bottom: .85rem;" onClick=${() => up((me) => { me.dontItems = [...(me.dontItems || []), '']; })}>+ Add to the second list</button>`;
}

function StopInspector({ d, k, RichTextEditor, onSelect }) {
  const s = d.work.stops[k];
  const used = d.work.pages.some(p => p.fields.some(f => f.stops && Object.values(f.stops).includes(k)));
  const set = (patch) => d.update((w) => { Object.assign(w.stops[k], patch); });
  return html`
    <h3 style="margin-top: 0;">Stop screen</h3>
    <${Field} label="Heading" id="afe-stop-title"><input id="afe-stop-title" class="form-input" value=${s.title} onInput=${(e) => set({ title: e.target.value })} /><//>
    <div class="afe-field">
      <span class="afe-label">Message</span>
      ${RichTextEditor
        ? html`<${RichTextEditor} value=${s.body || ''} minHeight=${120} label="Stop screen message" onChange=${(v) => set({ body: v })} />`
        : html`<textarea class="form-input" rows="5" value=${s.body || ''} onInput=${(e) => set({ body: e.target.value })}></textarea>`}
    </div>
    <label class="afe-check" style="margin-bottom: .85rem;">
      <input type="checkbox" checked=${!!s.image} onChange=${(e) => d.update((w) => { if (e.target.checked) w.stops[k].image = SERVICE_MAP_IMAGE; else delete w.stops[k].image; })} />
      Show the service area map
    </label>
    <p class="afe-hint">${used ? 'A choice in the form leads here.' : 'No choice leads here yet. Pick it on a question’s choices.'}</p>
    <button class="btn btn-ghost afe-danger" disabled=${used} title=${used ? 'A choice still leads here' : ''}
      onClick=${() => { if (!confirm('Delete this stop screen?')) return; d.update((w) => { delete w.stops[k]; }); onSelect({ kind: 'page', page: 0 }); }}>Delete this stop screen</button>`;
}

function SettingsInspector({ d }) {
  const emails = (d.work.staffEmails || []).join('\n');
  return html`
    <h3 style="margin-top: 0;">Settings</h3>
    <${Field} label="Who gets the new-application email" id="afe-staff" hint="One address per line. Each new application sends them the child's first name, makeover type and a link to the JobTread account.">
      <textarea id="afe-staff" class="form-input" rows="4" value=${emails} onInput=${(e) => d.update((w) => { w.staffEmails = e.target.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean); })}></textarea>
    <//>
    <p class="afe-hint">Open or close applications, and the season year, are in Site Config → Settings → Makeover Application.</p>`;
}

// ─── Messages ──────────────────────────────────────────────────────
const MESSAGE_INFO = [
  ['welcome', 'Application Status', 'Sent when an application comes in (and when staff add an applicant by hand with Status "Applied").'],
  ['copyNote', 'The "copy attached" line', 'Goes where {copyNote} is in the message above, only when the family applied on the website (their PDF is attached).'],
  ['inReview', 'Application In Review', 'Sent when Status changes to In Review.'],
  ['approved', 'Application Decision: approved', 'Sent when Status changes to Approved.'],
  ['denied', 'Application Decision: denied', 'Sent when Status changes to Denied.'],
];

function MessagesEditor({ d }) {
  const { work } = d;
  const refs = useRef({});
  if (!work) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;
  const msgs = work.messages || {};
  const insert = (k, token) => {
    const ta = refs.current[k];
    const v = msgs[k] || '';
    const at = ta ? ta.selectionStart : v.length;
    d.update((w) => { w.messages = { ...(w.messages || {}), [k]: v.slice(0, at) + token + v.slice(at) }; });
  };
  const render = (k) => String(msgs[k] || '')
    .replace(/\{parent\}/g, SAMPLE.parent).replace(/\{child\}/g, SAMPLE.child)
    .replace(/\{copyNote\}/g, msgs.copyNote ? `\n\n${msgs.copyNote}` : '');
  return html`
    <div>
      <${DraftBar} d=${d} />
      <${Problems} problems=${d.problems.filter(p => p.where.startsWith('messages/'))} />
      <div class="card">
        <h3 class="u-mb-1">Messages to families</h3>
        <p class="text-sm text-muted mb-1">These post on the family's JobTread account as the Qualification Committee, and JobTread emails them to the main parent. Their replies land on the account. Each one goes to a family once. *Stars* make bold text in JobTread.</p>
        ${MESSAGE_INFO.map(([k, title, note]) => html`
          <section class="afe-msg">
            <label for=${`afe-m-${k}`} style="font-weight: 700;">${title}</label>
            <span class="afe-hint">${note}</span>
            ${k !== 'copyNote' && html`<div class="afe-chips">
              <span class="afe-hint">Insert:</span>
              <button onClick=${() => insert(k, '{parent}')} title="The main parent's name">{parent}</button>
              <button onClick=${() => insert(k, '{child}')} title="The child's name">{child}</button>
              ${k === 'welcome' && html`<button onClick=${() => insert(k, '{copyNote}')} title="Where the copy-attached line goes">{copyNote}</button>`}
            </div>`}
            ${k === 'copyNote'
              ? html`<input id=${`afe-m-${k}`} class="form-input" value=${msgs[k] || ''} onInput=${(e) => d.update((w) => { w.messages = { ...(w.messages || {}), [k]: e.target.value }; })} />`
              : html`<textarea id=${`afe-m-${k}`} ref=${(el) => { refs.current[k] = el; }} class="form-input" value=${msgs[k] || ''} onInput=${(e) => d.update((w) => { w.messages = { ...(w.messages || {}), [k]: e.target.value }; })}></textarea>
                <details><summary class="afe-hint" style="cursor: pointer;">How it reads for ${SAMPLE.parent}</summary><div class="afe-msg-preview">${render(k)}</div></details>`}
          </section>`)}
      </div>
    </div>`;
}

// ─── History ───────────────────────────────────────────────────────
function HistoryTab({ d }) {
  const { meta } = d;
  if (!meta) return html`<div style="text-align:center;padding:2rem"><span class="spinner" /></div>`;
  const rows = meta.versions || [];
  const label = (s) => (s === 'live' ? html`<span class="badge badge-green">Live</span>` : s === 'draft' ? html`<span class="badge badge-yellow">Draft</span>` : html`<span class="badge badge-gray">Earlier</span>`);
  return html`
    <div class="card">
      <h3 class="u-mb-1">History</h3>
      <p class="text-sm text-muted mb-1">Every version that went live. Restoring one copies it into your draft so you can look it over before putting it live. Applications always keep the version they were answered on.</p>
      <div style="display: grid; gap: .5rem;">
        ${rows.map(v => html`
          <div style="display: flex; justify-content: space-between; align-items: center; gap: .75rem; flex-wrap: wrap; border: 1px solid var(--color-border); border-radius: 10px; padding: .6rem .8rem;">
            <div>
              <strong>Version ${v.version}</strong> ${label(v.state)}
              <div class="text-sm text-muted">${v.state === 'draft' ? `Edited ${when(v.updatedAt)}${v.updatedBy ? ` by ${v.updatedBy}` : ''}` : `Put live ${when(v.liveAt)}${v.liveBy ? ` by ${v.liveBy}` : ''}`}${v.note ? ` · ${v.note}` : ''}</div>
            </div>
            ${v.state === 'old' && html`<button class="btn btn-ghost" onClick=${() => d.restore(v.version)}>Restore as draft</button>`}
          </div>`)}
        <div style="display: flex; justify-content: space-between; align-items: center; gap: .75rem; flex-wrap: wrap; border: 1px solid var(--color-border); border-radius: 10px; padding: .6rem .8rem;">
          <div><strong>Built-in form</strong> ${meta.live.builtIn ? label('live') : label('old')}<div class="text-sm text-muted">The Jotform application as it stood for 2027.</div></div>
          ${!meta.live.builtIn && html`<button class="btn btn-ghost" onClick=${() => d.restore(0)}>Restore as draft</button>`}
        </div>
      </div>
    </div>`;
}
