/**
 * An Advisory Board meeting on the screen (/admin/advisory/screen/)
 * ===========================================================================
 * ?present  in its own window, to share on Google Meet or drag onto a TV: it moves itself (the arrow keys, a clicker)
 * ?preview  in a frame beside the agenda, told each change as it's typed, before it's saved
 * The screen is the board's own (../../board/screen.js, LOCAL there): it draws what this page gives it and asks the
 * board's routes for nothing. Only whoever runs the group opens this: /api/advisory-admin refuses anyone else.
 */

import { h, htm, render, useState, useEffect } from '../../vendor.js';
import { Screen } from '../../board/screen.js';
import { isFilled } from '../../board-shared.js';

const html = htm.bind(h);
const q = new URLSearchParams(location.search);
const PREVIEW = q.has('preview');
const idOf = () => (location.hash.match(/^#\/meetings\/([\w-]+)/) || [])[1] || '';

/** The draft as the screen wants it: what the server's view does, on the words as they're typed */
function draftView(m, was) {
  const files = (m.files || []).filter((f) => !f.staffOnly);
  const open = new Set(files.map((f) => f.id));
  return {
    ...was, date: m.date, start: m.start, end: m.end, location: m.location, address: m.address, files,
    title: String(m.title || '').trim() || was.title,
    sections: m.sections.map((s) => ({ ...s, items: s.items.filter(isFilled).map(({ staffNote, ...it }) => ({ ...it, docs: it.docs.filter((d) => open.has(d)) })) })).filter((s) => s.items.length),
  };
}

/** Back where they came from: the window that opened this one, else the page that linked here, else the meeting */
function goBack(id) {
  if (window.opener && !window.opener.closed) { window.opener.focus(); window.close(); return; }
  const from = document.referrer && new URL(document.referrer).origin === location.origin ? document.referrer : '';
  location.href = from || `/admin/advisory/#/meetings/${encodeURIComponent(id)}`;
}

function App() {
  const id = idOf();
  const [data, setData] = useState(null);
  const [fail, setFail] = useState('');
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/advisory-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'meeting-view', id }) });
        const j = await r.json();
        if (j.ok) setData(j); else setFail(j.error || 'This meeting didn’t open.');
      } catch { setFail('This meeting didn’t open. Check your connection and reload.'); }
    })();
  }, []);
  useEffect(() => {
    if (!PREVIEW) return undefined;
    document.documentElement.classList.add('is-preview');
    const msg = (e) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      const x = e.data || {};
      if (x.type === 'board-preview' && x.meeting?.id) setData((dd) => (dd ? { ...dd, meetings: dd.meetings.map((y) => (y.id === x.meeting.id ? draftView(x.meeting, y) : y)) } : dd));
      if (x.type === 'board-preview-focus' && x.itemId) dispatchEvent(new CustomEvent('bp-preview-focus', { detail: x.itemId }));
    };
    addEventListener('message', msg);
    return () => removeEventListener('message', msg);
  }, []);
  useEffect(() => { if (PREVIEW && data) window.parent?.postMessage({ type: 'board-preview-ready' }, location.origin); }, [!!data]);
  if (fail) return html`<div class="bs bs--center"><div class="bs-cover__lead"><h1 class="bs-h1">${fail}</h1></div></div>`;
  if (!data) return html`<div class="bs bs--center bs--opening" role="status"></div>`;
  return html`<${Screen} id=${id} data=${data} d=${{ people: data.people }} onBack=${() => goBack(id)} />`;
}

render(html`<${App} />`, document.getElementById('board-app'));
