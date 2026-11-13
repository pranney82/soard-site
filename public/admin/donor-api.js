/**
 * donor-api.js — what Donors & Partners (./donors.js) and a page's Timeline (./donor-timeline.js) share
 * =====================================================================================================
 * The site's answers (`call`, `get`), a change sent until it really answers (`change`), and a note being written
 * kept in this browser until it's saved (the drafts).
 */

const API = '/api/donors-admin';

export async function call(params = '', body = null) {
  try {
    // (a change goes on even when the tab closes or reloads mid-way: keepalive, every change being small)
    const r = await fetch(`${API}${params}`, body ? { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) } : { headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    return j ? (j.success ? j : { ...j, status: r.status }) : { success: false, error: 'The site didn’t answer.', status: r.status };
  } catch {
    return { success: false, error: 'The site didn’t answer.' };
  }
}
export const get = (params) => call(params);

// A thank-you was said (or undone): the sidebar's count, the list, To thank and a donor's page all read again. With a
// value, only the count just read (the sidebar takes it; nothing else needs to read)
export const thanksChanged = (value) => window.dispatchEvent(new CustomEvent('soard-thanks-changed', value === undefined ? undefined : { detail: { value } }));

// What else reads again after a change that was refused or whose answer was lost (Donors' list: ./donors.js)
let afterUnsure = () => {};
export const whenUnsure = (fn) => { afterUnsure = fn; };

/**
 * A change. Refused, or its answer lost on the way back (it may have saved all the same): every view of Donors &
 * Partners open reads again (the list, Needs you, To thank, the page, the sidebar), so none shows what was before.
 * Every change, sent twice, is made once and answers as it is (done already, or refused): an answer lost on the way
 * back is asked again, so the page says what really happened
 */
export const lostAnswer = (r) => !r.success && (!r.status || r.status >= 500);
// A change's answer names the mark it moved the lists to: this tab's own, so the counts' look never takes it for a
// teammate's (and a teammate's landing just after is never taken for this one)
const ownRev = (r) => { if (Number.isFinite(r?.rev)) window.dispatchEvent(new CustomEvent('soard-donors-rev', { detail: { rev: r.rev } })); };
export const change = async (body) => {
  let r = await call('', body);
  ownRev(r);
  // (three times more, further apart each time: a short outage, or answers lost in a row, still ends in what really
  // happened. Every change sent again is made once and answers as it is, so asking again is how it's known)
  for (const ms of [0, 800, 2500]) {
    if (!lostAnswer(r)) break;
    if (ms) await new Promise((ok) => setTimeout(ok, ms));
    r = { ...(await call('', body)), retried: true };
    ownRev(r);
  }
  if (!r.success) {
    afterUnsure();
    thanksChanged();
    if (lostAnswer(r)) r = { ...r, error: 'The site didn’t answer. The page reads again, so what shows is what’s saved.' };
  }
  return r;
};

// A note being written and not saved: kept in this browser (a move, Back, a reload, closing it), and back in its box
// when the donor's page shows again, for a week. Nothing ever asks before leaving, and nothing typed is lost
const DRAFT_DAYS = 7;
// This tab, named in what it keeps: another tab on the same giver tells its own words from the words it showed
const makeId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));
// This page as loaded: another tab (a duplicated one too) is another, so what each box shows is told apart
export const TAB = makeId();
// This tab across its reloads (sessionStorage): a change it kept before a reload is its own to put back
export const HOME = (() => {
  try { let t = sessionStorage.getItem('soard-tab'); if (!t) { t = makeId(); sessionStorage.setItem('soard-tab', t); } return t; } catch { return TAB; }
})();
export const draftKey = (subject, part) => `soard-note-draft:${subject}:${part}`;
export const keepDraft = (k, v) => { try { if (v) localStorage.setItem(k, JSON.stringify({ ...v, tab: v.tab || TAB, home: v.home || HOME, at: Date.now() })); else localStorage.removeItem(k); } catch { /* storage off: nothing kept */ } };
export const draftOf = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v && Date.now() - v.at < DRAFT_DAYS * 864e5 ? v : null; } catch { return null; } };
/** A change being made to a note: kept by the note's own id (it's that note's, wherever it shows: two notes changed in
 * two tabs are two, and a page that moves leaves it with its note) */
export const editKey = (id) => `soard-note-draft:edit:${id}`;
/** Every change being made to a note, kept in this browser: [{ id, from, draft, subject, at }] */
export function editDrafts() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('soard-note-draft:edit:')) continue;
      const v = draftOf(k);
      if (v?.id) out.push(v);
    }
  } catch { /* storage off: none */ }
  return out;
}
/** The page now under another address (counted for an organization, put on the website, joined under another lead,
 * opened at an address that leads there now): a new note's words being written go with it, after any kept there (a
 * change to a note stays with its note) */
export function moveDraft(from, to) {
  if (!from || !to || from === to) return;
  const n = draftOf(draftKey(from, 'new'));
  const raw = String(n?.text || '');
  if (raw.trim()) {
    // What's kept there, by where each part came from (typed there: no source). The same source moved again (its page
    // still open, typed on since): its part replaced, never doubled; others' words are theirs, kept whole
    const dest = draftOf(draftKey(to, 'new'));
    const parts = Array.isArray(dest?.parts) ? dest.parts.map((p) => ({ ...p })) : String(dest?.text || '').trim() ? [{ src: null, text: String(dest.text) }] : [];
    const mine = parts.find((p) => p.src === from);
    if (mine) mine.text = raw; else parts.push({ src: from, text: raw });
    // (alone, the words go just as typed, a space at the end too, so typing goes on where it was)
    const text = parts.length === 1 ? parts[0].text : parts.map((p) => p.text.trim()).filter(Boolean).join('\n\n');
    // (the note's id goes along with words that are just what Add note sent, and that it's still landing)
    keepDraft(draftKey(to, 'new'), { text, parts, moved: true, ...(n?.id && parts.length === 1 ? { id: n.id, ...(n.sending ? { sending: n.sending } : {}) } : {}) });
    // (where they went, said where they were: a tab still showing that page reads it again and goes there with them)
    keepDraft(draftKey(from, 'new'), { movedTo: to });
    return;
  }
  keepDraft(draftKey(from, 'new'), null);
}
/** A note saved, said to every other tab (one on the same giver reads its page again) */
export const noteSaved = (subject, id) => { try { localStorage.setItem('soard-note-saved', JSON.stringify({ subject, id, tab: TAB, at: Date.now() })); } catch { /* storage off */ } };
