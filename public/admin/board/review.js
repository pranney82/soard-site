/**
 * review.js — the money item's presenter goes over the numbers
 * ===========================================================================
 * The page the treasurer writes their report on (./portal.js ReportPage, for an item that shows the money) opens with
 * the numbers to go over: QuickBooks' profit and loss and balance sheet beside the same day a year before, and the
 * budget against what came in and went out once the books keep one, every line with its change. The lines that moved
 * most are picked out ("Worth a word"), and any line takes a note, saved as it's typed
 * (POST /api/board-portal { action: 'line-note' }).
 *
 * The notes then sit under their lines wherever the board reads the numbers: the money item on the board page
 * (./portal.js Statement), the screen (./books.js StatementLines) and Print it all (./print.js statementsBox).
 *
 *   lineKeysOf      a line's key by its place (its headings and its name), never its row: QuickBooks adds accounts
 *   worthAWord      the lines that moved most, and the budget lines furthest off
 *   FinanceReview   the page's part: the due date, Worth a word, the statements with a note on any line
 *   NoteLine        a note as the board reads it, under its line
 *   withLineNotes   the page's data with one item's notes swapped in
 */

import { h, htm, useState, useEffect, useRef, useMemo } from '../vendor.js';
import { money } from '../board-shared.js';
import { compact } from './money.js';

const html = htm.bind(h);
const API = '/api/board-portal';

// ─── Lines and their keys ───────────────────────────────────────────

/**
 * Each row's key (an array beside rows): the statement ('act' the profit and loss, 'pos' the balance sheet, 'bud' the
 * budget against the actuals) with the line's headings and its name: "act|Income/Store Income"
 */
export function lineKeysOf(rows, which) {
  const path = [];
  return (rows || []).map((r) => {
    const d = Math.max(0, Number(r.d) || 0);
    path.length = Math.min(path.length, d);
    const key = `${which}|${[...path, r.label].join('/')}`;
    if (r.k === 'head') path[d] = r.label;
    return key;
  });
}

/** An item's notes as a map by line key */
export const notesByKey = (list) => new Map((Array.isArray(list) ? list : []).filter((n) => n?.key && n.text).map((n) => [n.key, n]));

/** The page's data with one item's notes swapped in (what the server answered) */
export const withLineNotes = (data, meetingId, itemId, list) => ({
  ...data,
  lineNotes: { ...(data.lineNotes || {}), [meetingId]: { ...(data.lineNotes?.[meetingId] || {}), [itemId]: list } },
});

// ─── Words and numbers ──────────────────────────────────────────────

const ET = 'America/New_York';
const signed = (n) => (typeof n === 'number' ? `${n < 0 ? '−' : ''}${money(Math.abs(n))}` : '–');
const short = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const fullDate = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
/** "+$12,345" / "−$12,345" against the year before ('' with nothing to set it beside) */
const diffText = (a, p) => (typeof a === 'number' && typeof p === 'number' ? (a === p ? 'Same' : `${a > p ? '+' : '−'}${money(Math.abs(a - p))}`) : '');
/** "▲ 12%", "New" when last year had none */
const pctText = (a, p) => {
  if (typeof a !== 'number' || typeof p !== 'number' || a === p) return '';
  if (p === 0) return 'New';
  const c = Math.round(((a - p) / Math.abs(p)) * 100);
  return c === 0 ? '' : `${c > 0 ? '▲' : '▼'} ${Math.abs(c)}%`;
};
/** "Wed, Nov 4 at noon" (Atlanta's time) */
export function dueText(iso) {
  const t = new Date(iso || '');
  if (Number.isNaN(t.getTime())) return '';
  const day = t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: ET });
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: ET }).formatToParts(t).map((x) => [x.type, x.value]));
  const time = p.hour === '12' && p.minute === '00' && /p/i.test(p.dayPeriod) ? 'noon' : `${p.hour}${p.minute === '00' ? '' : `:${p.minute}`} ${String(p.dayPeriod || '').toUpperCase()}`;
  return `${day} at ${time}`;
}
/** "Nov 3" (Atlanta's day) */
const dayShort = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: ET }) : ''; };
/** A line's place on the page, as an id (keys hold spaces and slashes) */
const rowId = (key) => `fr-${[...String(key)].reduce((x, c) => ((x * 33) ^ c.charCodeAt(0)) >>> 0, 5381).toString(36)}`;
/** Is a budget line money in (under the Income headings) or money out (cost of goods, expenses)? By its top heading */
const isIncome = (key) => /income|revenue/i.test(String(key).split('|')[1]?.split('/')[0] || '');
/** "112% of budget" */
const ofBudget = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > 0 ? `${Math.round((a / b) * 100)}% of budget` : '');
/** "$12,345 over" / "$12,345 under" / "On budget" */
const againstText = (a, b) => (typeof a === 'number' && typeof b === 'number' ? (Math.round(a) === Math.round(b) ? 'On budget' : `${money(Math.abs(a - b))} ${a > b ? 'over' : 'under'}`) : '');

// ─── Worth a word ───────────────────────────────────────────────────

/**
 * The lines that moved most since the year before (at least $10,000 and 15%, or new), the same movement once (a total
 * of one account is that account; the two sides of a balance sheet are one), biggest first; then the budget lines
 * furthest off (spending 10% and $5,000 over its budget so far, income as far short). → [{ which, key, label, a, p,
 * text }]
 */
export function worthAWord(s, budget = null, { most = 6 } = {}) {
  const found = [];
  for (const [which, rows] of [['act', s?.activity], ['pos', s?.position]]) {
    const keys = lineKeysOf(rows, which);
    (rows || []).forEach((r, i) => {
      if (!['acct', 'total', 'sum'].includes(r.k) || typeof r.a !== 'number' || typeof r.p !== 'number') return;
      // Equity moves by the year's own net and its close: the profit and loss explains it
      if (which === 'pos' && /(^|\/)equity(\/|$)/i.test(keys[i].split('|')[1])) return;
      const size = Math.abs(r.a - r.p);
      if (size < 10000 || (r.p !== 0 && size / Math.abs(r.p) < 0.15)) return;
      found.push({ which, key: keys[i], label: r.label, a: r.a, p: r.p, size, rank: (which === 'act' ? 0 : 3) + (r.k === 'acct' ? 0 : r.k === 'total' ? 1 : 2), text: `${r.a > r.p ? '▲' : '▼'} ${compact(size)}`, sub: pctText(r.a, r.p) });
    });
  }
  // The same two numbers are the same movement (Net Income and Net Operating Income, a total of one account): once,
  // on the profit and loss first, its most specific line
  const once = new Map();
  for (const f of found.sort((x, y) => x.rank - y.rank)) {
    const same = `${f.a}:${f.p}`;
    if (!once.has(same)) once.set(same, f);
  }
  const moved = [...once.values()].sort((x, y) => y.size - x.size).slice(0, most);
  // The budget's own lines (_quickbooks.js: a the actual, b the budget so far): spending over, income short
  const rows = budget?.rows || [];
  const keys = lineKeysOf(rows, 'bud');
  const off = rows.map((r, i) => {
    if (r.k !== 'acct' || typeof r.a !== 'number' || typeof r.b !== 'number' || !(r.b > 0)) return null;
    const bad = isIncome(keys[i]) ? r.b - r.a : r.a - r.b;
    if (bad < 5000 || bad / r.b < 0.1) return null;
    return { which: 'bud', key: keys[i], label: r.label, a: r.a, p: r.b, size: bad, text: ofBudget(r.a, r.b), sub: '' };
  }).filter(Boolean).sort((x, y) => y.size - x.size).slice(0, 3);
  return [...moved, ...off];
}

// ─── Small pictures ─────────────────────────────────────────────────

const PATHS = {
  pen: html`<path d="M4.5 19.5h4l10.5-10.5a2.83 2.83 0 0 0-4-4L4.5 15.5z" /><path d="m13.5 6.5 4 4" />`,
  check: html`<path d="m5 12.5 4.5 4.5L19 7.5" />`,
};
const Pic = ({ name, size = 16 }) => html`<svg class="fr-pic" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;

// ─── A note ─────────────────────────────────────────────────────────

/** A note as the board reads it, under its line: the words, then whose they are */
export function NoteLine({ note, cls = 'ln-note' }) {
  if (!note?.text) return null;
  return html`<p class=${cls}><span class="ln-note__text">${note.text}</span>${note.by ? html` <span class="ln-note__by">${note.by}</span>` : null}</p>`;
}
/** A note on paper or in words alone: "Store down: the shop closed in March. (Sam Ortiz)" */
export const noteText = (note) => (note?.text ? `${note.text}${note.by ? ` (${note.by})` : ''}` : '');

async function post(body) {
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ ok: false, error: /cloudflareaccess/i.test(r.url || '') ? 'Your sign-in expired. Reload the page to sign in again.' : `Something went wrong (${r.status})` }));
    if (!r.ok && j.ok !== false) j.ok = false;
    j.status = r.status;
    return j;
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
}

/**
 * Writing a note on one line: saved a moment after they stop typing, when the box loses focus, and when the page goes.
 * Done closes it (saved first); Escape too. Emptied, the note is gone.
 */
function NoteEditor({ meetingId, itemId, k, line, note, onSaved, onClose }) {
  const [text, setText] = useState(note?.text || '');
  const [st, setSt] = useState(''); // '' | waiting | saving | saved | the error
  const sent = useRef((note?.text || '').trim());
  const latest = useRef(text);
  latest.current = text;
  const timer = useRef(0);
  const busy = useRef(null);
  const box = useRef(null);
  const body = (words) => ({ action: 'line-note', meetingId, itemId, key: k, line, text: words });
  const save = async () => {
    clearTimeout(timer.current);
    if (busy.current) { await busy.current; }
    const words = latest.current.trim();
    if (words === sent.current) { setSt((x) => (x === 'waiting' ? 'saved' : x)); return true; }
    setSt('saving');
    busy.current = post(body(words));
    const j = await busy.current;
    busy.current = null;
    if (!j.ok) { setSt(j.error || 'Couldn’t save'); return false; }
    sent.current = words;
    onSaved(Array.isArray(j.notes) ? j.notes : []);
    if (latest.current.trim() !== words) { setSt('waiting'); timer.current = setTimeout(save, 400); } else setSt('saved');
    return true;
  };
  useEffect(() => {
    // The page going (another page, the tab closed): what's typed goes, blind
    const flush = () => {
      const words = latest.current.trim();
      if (words === sent.current) return;
      try { fetch(API, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(words)) }); } catch { /* the page is going */ }
    };
    addEventListener('pagehide', flush);
    return () => { removeEventListener('pagehide', flush); clearTimeout(timer.current); if (latest.current.trim() !== sent.current) save(); };
  }, []);
  const done = async () => { if (await save()) onClose(); };
  const status = st === 'saving' ? 'Saving…' : st === 'waiting' ? 'Saving in a moment' : st === 'saved' ? (sent.current ? 'Saved' : 'Note taken off') : st
    ? html`<span class="fr-note__err" role="alert">Not saved: ${st} <button type="button" class="fr-linkbtn" onClick=${save}>Try again</button></span>` : '';
  const id = `${rowId(k)}-t`;
  return html`<div class="fr-note is-editing">
    <label class="sr-only" for=${id}>Your note on ${line}</label>
    <textarea id=${id} ref=${(el) => { box.current = el; if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length); } }} rows="2" value=${text} placeholder="Why it moved, what the board should know, a question you’ll ask"
      onInput=${(e) => { setText(e.target.value); latest.current = e.target.value; setSt('waiting'); clearTimeout(timer.current); timer.current = setTimeout(save, 900); }}
      onBlur=${() => save()}
      onKeyDown=${(e) => { if (e.key === 'Escape') { e.preventDefault(); done(); } }}></textarea>
    <div class="fr-note__foot">
      <span class="fr-note__st" aria-live="polite">${status}</span>
      <span class="fr-note__acts">
        ${sent.current || text.trim() ? html`<button type="button" class="fr-linkbtn" onClick=${() => { setText(''); latest.current = ''; done(); }}>Take the note off</button>` : null}
        <button type="button" class="fr-done" onClick=${done}>Done</button>
      </span>
    </div>
  </div>`;
}

// ─── The page's part ────────────────────────────────────────────────

/**
 * One statement's lines, each with this year, the year before and the change, or (which 'bud') the actual, the budget
 * so far and how far off it is; a line takes a note
 */
function Lines({ which, rows, asOf, priorAsOf, flags, notes, open, setOpen, canEdit, meetingId, itemId, onSaved, caption }) {
  const keys = useMemo(() => lineKeysOf(rows, which), [rows, which]);
  const bud = which === 'bud';
  const prior = rows.some((r) => (bud ? r.b : r.p) != null);
  const cols = prior ? 4 : 2;
  const heads = bud ? ['Actual', 'Budget so far', 'Against it'] : [short(asOf), short(priorAsOf), 'Change'];
  return html`<table class=${`fr-table ${bud ? 'fr-table--bud' : ''}`}>
    <caption class="sr-only">${caption}</caption>
    <thead><tr><th scope="col"><span class="sr-only">Line</span></th><th scope="col" class="num">${heads[0]}</th>${prior ? html`<th scope="col" class="num">${heads[1]}</th><th scope="col" class="num">${heads[2]}</th>` : null}</tr></thead>
    <tbody>${rows.flatMap((r, i) => {
      const k = keys[i];
      if (r.k === 'head') return [html`<tr class="fr-row fr-row--head" key=${k}><th scope="colgroup" colspan=${cols} style=${`--d:${r.d || 0}`}>${r.label}</th></tr>`];
      const note = notes.get(k);
      const isOpen = open === k;
      const flag = flags.has(k);
      const label = html`${flag ? html`<span class="fr-flag" title="Worth a word"><span class="sr-only">Worth a word: </span></span>` : null}<span class="fr-line__name">${r.label}</span>`;
      const out = [html`<tr class=${`fr-row fr-row--${r.k} ${isOpen ? 'is-open' : ''} ${note ? 'has-note' : ''}`} key=${k} id=${rowId(k)} style=${`--d:${r.d || 0}`}>
        <th scope="row">${canEdit
          ? html`<button type="button" class="fr-line" aria-expanded=${isOpen} aria-controls=${isOpen ? `${rowId(k)}-n` : null} onClick=${() => setOpen(isOpen ? '' : k)}>${label}<span class="fr-line__pen">${note ? null : html`<${Pic} name="pen" size=${14} /><span class="sr-only">Write a note on ${r.label}</span>`}</span></button>`
          : label}</th>
        <td class="num fr-now">${signed(r.a)}</td>
        ${prior && bud ? html`<td class="num fr-then" data-label="Budget so far">${signed(r.b)}${typeof r.y === 'number' && r.y !== r.b ? html`<small>${compact(r.y)} for the year</small>` : null}</td><td class="num fr-chg">${againstText(r.a, r.b)}${ofBudget(r.a, r.b) ? html`<small>${ofBudget(r.a, r.b)}</small>` : null}</td>`
          : prior ? html`<td class="num fr-then" data-label=${short(priorAsOf)}>${signed(r.p)}</td><td class="num fr-chg">${diffText(r.a, r.p)}${pctText(r.a, r.p) ? html`<small>${pctText(r.a, r.p)}</small>` : null}</td>` : null}
      </tr>`];
      if (isOpen || note) {
        out.push(html`<tr class="fr-noterow" key=${`${k}-n`} id=${`${rowId(k)}-n`} style=${`--d:${r.d || 0}`}><td colspan=${cols}>
          ${isOpen ? html`<${NoteEditor} meetingId=${meetingId} itemId=${itemId} k=${k} line=${r.label} note=${note} onSaved=${onSaved} onClose=${() => { setOpen(''); requestAnimationFrame(() => document.querySelector(`#${rowId(k)} .fr-line`)?.focus()); }} />`
            : html`<div class="fr-note"><p class="fr-note__text">${note.text}</p><p class="fr-note__by">${[note.by, dayShort(note.at)].filter(Boolean).join(', ')}${canEdit ? html` · <button type="button" class="fr-linkbtn" onClick=${() => setOpen(k)}>Change it</button>` : null}</p></div>`}
        </td></tr>`);
      }
      return out;
    })}</tbody>
  </table>`;
}

/**
 * The numbers to go over, above the report: when the report is due, the lines worth a word, then the statements (and
 * the budget) with a note on any line. `notes`: this item's [{ key, line, text, by, at }]; `due`: its ask
 * ({ due, status }) or null; `canEdit`: they present it (anyone else reads it, notes and all)
 */
export function FinanceReview({ books, meeting, item, notes = [], due = null, canEdit = false, onSaved = () => {} }) {
  const s = books?.statements || null;
  const budget = books?.budget?.rows?.length ? books.budget : null;
  const tabs = [s?.activity?.length ? ['act', 'Profit & loss'] : null, s?.position?.length ? ['pos', 'Balance sheet'] : null, budget ? ['bud', 'Budget vs actual'] : null].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]?.[0] || 'act');
  const [open, setOpen] = useState('');
  const [allChips, setAllChips] = useState(false);
  const byKey = useMemo(() => notesByKey(notes), [notes]);
  const movers = useMemo(() => worthAWord(s, budget), [s, budget]);
  const flags = useMemo(() => new Set(movers.map((x) => x.key)), [movers]);
  if (!tabs.length) return null;
  const show = tabs.some(([t]) => t === tab) ? tab : tabs[0][0];
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** A line picked out: its statement, the line in view, its note open (or, reading, the line marked) */
  const go = (x) => {
    setTab(x.which);
    if (canEdit) setOpen(x.key);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const row = document.getElementById(rowId(x.key));
      if (!row) return;
      row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      if (canEdit) document.getElementById(`${rowId(x.key)}-t`)?.focus({ preventScroll: true });
      else { row.classList.add('is-marked'); setTimeout(() => row.classList.remove('is-marked'), 1600); }
    }));
  };
  // In means the report is there (an ask's status can say 'in' for a conversation that isn't one)
  const inNow = !!item?.report;
  const late = due && !inNow && Date.parse(due.due) < Date.now();
  const lastYear = s?.priorAsOf ? s.priorAsOf.slice(0, 4) : '';
  const shared = { flags, notes: byKey, open, setOpen, canEdit, meetingId: meeting.id, itemId: item.id, onSaved };
  const count = byKey.size;
  return html`<section class="bp-card fr" aria-labelledby="fr-h">
    <div class="fr-top">
      <div>
        <h2 class="fr-h" id="fr-h">The numbers to go over</h2>
        <p class="fr-when">${s ? `From QuickBooks, through ${fullDate(s.asOf)}${s.closed ? ' (the books are closed through then)' : ''}${lastYear ? `, beside the same day of ${lastYear}` : ''}.` : ''}</p>
      </div>
      ${due?.due ? html`<span class=${`bp-chip ${inNow ? 'bp-chip--ok' : late ? 'bp-chip--warn' : ''} fr-due`}>${inNow ? html`<${Pic} name="check" size=${14} />Your report is in` : `${late ? 'Was due' : 'Due'} ${dueText(due.due)}`}</span>` : null}
    </div>
    ${movers.length ? html`<div class="fr-worth">
      <h3 class="bp-mini-h">Worth a word</h3>
      <p class="fr-how">What moved most since last year${budget ? ', and the budget lines furthest off' : ''}. ${canEdit ? 'Tap one to write a note on it.' : ''}</p>
      <ul class=${`fr-chips ${allChips ? 'is-all' : ''}`}>${movers.map((x) => html`<li key=${x.key}><button type="button" class=${`fr-chip ${byKey.has(x.key) ? 'is-noted' : ''}`} onClick=${() => go(x)}>
        ${byKey.has(x.key) ? html`<span class="fr-chip__ok"><${Pic} name="check" size=${14} /><span class="sr-only">Has a note: </span></span>` : html`<span class="fr-chip__dot" aria-hidden="true"></span>`}
        <span class="fr-chip__name">${x.label}</span><span class="fr-chip__chg">${x.text}${x.sub ? ` · ${x.sub}` : ''}</span>
      </button></li>`)}</ul>
      ${movers.length > 5 && !allChips ? html`<button type="button" class="fr-linkbtn fr-more" onClick=${() => setAllChips(true)}>${movers.length - 5} more</button>` : null}
    </div>` : null}
    <div class="fr-tabs">
      ${tabs.length > 1 ? html`<div class="bp-impact__seg" role="group" aria-label="Which numbers">${tabs.map(([t, label]) => html`<button type="button" key=${t} aria-pressed=${show === t} onClick=${() => { setTab(t); setOpen(''); }}>${label}</button>`)}</div>` : null}
      ${canEdit ? html`<p class="fr-how fr-how--tap">Tap any line to write a note on it.</p>` : null}
    </div>
    <div class="fr-scroll">
      ${show === 'bud' ? html`<${Lines} which="bud" rows=${budget.rows} asOf=${budget.asOf} caption="The budget so far against the actuals" ...${shared} key="bud" />`
        : show === 'pos' ? html`<${Lines} which="pos" rows=${s.position} asOf=${s.asOf} priorAsOf=${s.priorAsOf} caption="Balance sheet" ...${shared} key="pos" />`
        : html`<${Lines} which="act" rows=${s.activity} asOf=${s.asOf} priorAsOf=${s.priorAsOf} caption="Profit and loss" ...${shared} key="act" />`}
    </div>
    ${show === 'bud' && budget?.asOf ? html`<p class="fr-how">QuickBooks’ ${budget.name ? `budget “${budget.name}”` : 'budget'}, January 1 through ${fullDate(budget.asOf)}.</p>` : null}
    <p class="fr-foot">${count ? `${count === 1 ? 'Your note shows' : `Your ${count} notes show`} under ${count === 1 ? 'its line' : 'their lines'} for the board: on the agenda, on the screen and in Print it all.` : canEdit ? 'Notes show under their lines for the board: on the agenda, on the screen and in Print it all.' : 'No notes on these numbers yet.'}</p>
  </section>`;
}

// ─── Its look (the board page's tokens; the screen and paper bring their own) ───

const CSS = `
.fr { margin: 0 0 1.4rem; padding: 1.2rem 1.3rem 1rem; }
.fr-top { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.6rem 1.25rem; }
.fr-h { margin: 0; font-family: var(--display); font-size: 1.22rem; line-height: 1.3; }
.fr-when { margin: 0.3rem 0 0; color: var(--muted); font-size: 0.9rem; max-width: 34rem; }
.fr-due { margin-top: 0.15rem; font-variant-numeric: tabular-nums; }
.fr-due .fr-pic { margin-right: 0.1rem; }
.fr-worth { margin: 1.15rem 0 0; }
.fr-worth .bp-mini-h { margin: 0 0 0.2rem; }
.fr-how { margin: 0; color: var(--muted); font-size: 0.88rem; }
.fr-chips { list-style: none; margin: 0.6rem 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.5rem; }
.fr-chip { display: inline-flex; align-items: center; gap: 0.5rem; min-height: 44px; max-width: 100%; padding: 0.35rem 0.9rem 0.35rem 0.75rem; border: 1px solid var(--line-2); border-radius: 999px; background: var(--card); color: var(--ink); font: inherit; font-size: 0.9rem; font-weight: 600; text-align: left; cursor: pointer; transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s var(--ease); }
.fr-chip:hover { border-color: var(--ink-2); box-shadow: var(--shadow-1); transform: translateY(-1px); }
.fr-chip:active { transform: none; }
.fr-chip.is-noted { background: var(--ok-bg); border-color: transparent; }
.fr-chip__dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--yellow-2); box-shadow: 0 0 0 3px var(--yellow-soft); }
.fr-chip__ok { flex: none; display: inline-flex; color: var(--ok); }
.fr-chip__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-chip__chg { flex: none; color: var(--muted); font-weight: 500; font-variant-numeric: tabular-nums; }
.fr-tabs { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; margin: 1.3rem 0 0.4rem; }
.fr-how--tap { font-size: 0.84rem; }
.fr-scroll { margin: 0 -0.35rem; }
.fr-table { width: 100%; border-collapse: collapse; font-size: 0.92rem; font-variant-numeric: tabular-nums; }
.fr-table th, .fr-table td { padding: 0.45rem 0.35rem; border-bottom: 1px solid var(--line); vertical-align: top; }
.fr-table thead th { padding-top: 0.2rem; font-size: 0.72rem; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); white-space: nowrap; }
.fr-table .num { text-align: right; white-space: nowrap; }
.fr-table th[scope="row"] { text-align: left; font-weight: 450; padding-left: calc(var(--d, 0) * 1.1rem + 0.35rem); }
.fr-row--head th { padding-top: 1rem; text-align: left; font-size: 0.74rem; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); border-bottom: none; padding-left: calc(var(--d, 0) * 1.1rem + 0.35rem); }
.fr-row--total th, .fr-row--total td { font-weight: 700; }
.fr-row--sum th, .fr-row--sum td { font-weight: 750; border-top: 2px solid var(--line-2); }
.fr-row--total th[scope="row"], .fr-row--sum th[scope="row"] { font-weight: inherit; }
.fr-chg small, .fr-then small { display: block; font-size: 0.78rem; color: var(--muted); font-weight: 500; }
.fr-then { color: var(--muted); }
.fr-line { display: inline-flex; align-items: baseline; gap: 0.45rem; max-width: 100%; margin: -0.3rem -0.4rem; padding: 0.3rem 0.4rem; border: none; border-radius: 8px; background: none; color: inherit; font: inherit; font-weight: inherit; text-align: left; cursor: pointer; }
.fr-line:hover { background: var(--yellow-wash); }
.fr-line:hover .fr-line__name { text-decoration: underline; text-decoration-color: var(--yellow-2); text-decoration-thickness: 2px; text-underline-offset: 3px; }
.fr-line__pen { display: inline-flex; color: var(--quiet); opacity: 0; transition: opacity 0.15s; align-self: center; }
.fr-line:hover .fr-line__pen, .fr-line:focus-visible .fr-line__pen, .fr-row.is-open .fr-line__pen { opacity: 1; }
.fr-flag { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--yellow-2); box-shadow: 0 0 0 3px var(--yellow-soft); align-self: center; margin-right: 0.1rem; }
.fr-row.is-open th, .fr-row.is-open td, .fr-row.is-marked th, .fr-row.is-marked td { background: var(--yellow-wash); }
.fr-row.is-open th, .fr-row.is-open td, .fr-row.has-note th, .fr-row.has-note td { border-bottom-color: transparent; }
.fr-row.is-marked th, .fr-row.is-marked td { transition: background 0.6s; }
.fr-noterow td { padding: 0 0.35rem 0.75rem calc(var(--d, 0) * 1.1rem + 0.35rem); }
.fr-note { border-left: 3px solid var(--yellow); padding: 0.5rem 0.8rem 0.55rem; background: var(--yellow-wash); border-radius: 0 10px 10px 0; }
.fr-note__text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.fr-note__by { margin: 0.2rem 0 0; font-size: 0.8rem; color: var(--muted); }
.fr-note textarea { display: block; width: 100%; min-height: 4.4em; field-sizing: content; max-height: 18rem; padding: 0.55rem 0.7rem; border: 1px solid var(--line-2); border-radius: 10px; background: var(--card); color: var(--ink); font: inherit; font-size: 0.95rem; line-height: 1.45; resize: vertical; }
.fr-note textarea:focus { outline: none; border-color: var(--ink); box-shadow: 0 0 0 3px var(--yellow-soft); }
.fr-note__foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.35rem 1rem; margin-top: 0.45rem; font-size: 0.82rem; color: var(--muted); }
.fr-note__acts { display: inline-flex; align-items: center; gap: 1rem; margin-left: auto; }
.fr-note__err { color: var(--warn); font-weight: 600; }
.fr-done { min-height: 36px; padding: 0 1rem; border: none; border-radius: 999px; background: var(--yellow); color: #1E1F1C; font: inherit; font-size: 0.88rem; font-weight: 650; cursor: pointer; }
.fr-done:hover { background: var(--yellow-2); }
.fr-linkbtn { padding: 0.3rem 0; border: none; background: none; color: var(--info); font: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.fr-foot { margin: 0.9rem 0 0; color: var(--muted); font-size: 0.85rem; }
.fr-more { display: none; margin-top: 0.5rem; font-size: 0.88rem; }
@media (max-width: 640px) {
  .fr { padding: 1rem 1rem 0.9rem; }
  .fr-chip { font-size: 0.86rem; }
  .fr-chips:not(.is-all) li:nth-child(n+6) { display: none; }
  .fr-more { display: inline-block; }
  .fr-tabs .bp-impact__seg { display: flex; width: 100%; }
  .fr-tabs .bp-impact__seg button { flex: 1 1 auto; padding: 0 0.45rem; font-size: 0.82rem; }
  .fr-scroll { margin: 0; }
  .fr-table, .fr-table tbody { display: block; }
  .fr-table thead { display: none; }
  .fr-table tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 0.1rem 0.9rem; padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
  .fr-table th, .fr-table td { padding: 0 !important; border: none !important; }
  .fr-table th[scope="row"] { padding-left: calc(var(--d, 0) * 0.7rem) !important; }
  .fr-row--head { padding: 0.9rem 0 0.1rem !important; border-bottom: none !important; }
  .fr-row--head th { padding-left: calc(var(--d, 0) * 0.7rem) !important; }
  .fr-table td.fr-then { grid-column: 1; text-align: left; font-size: 0.8rem; white-space: normal; padding-left: calc(var(--d, 0) * 0.7rem) !important; }
  .fr-table td.fr-then small { display: none; }
  .fr-table td.fr-then::before { content: attr(data-label) ": "; }
  .fr-table td.fr-chg { grid-column: 2; font-size: 0.8rem; color: var(--muted); }
  .fr-chg small { display: inline; margin-left: 0.35rem; }
  .fr-table--bud .fr-chg small { display: block; margin-left: 0; }
  .fr-row--sum { border-top: 2px solid var(--line-2); }
  .fr-row.is-open, .fr-row.has-note { border-bottom: none; }
  .fr-noterow { display: block !important; padding: 0 0 0.7rem !important; }
  .fr-noterow td { display: block; padding-left: calc(var(--d, 0) * 0.7rem) !important; }
  .fr-line__pen { opacity: 1; }
  .fr-row.is-open { background: var(--yellow-wash); }
}
@media (prefers-reduced-motion: reduce) { .fr-chip, .fr-line__pen, .fr-row.is-marked th, .fr-row.is-marked td { transition: none; } .fr-chip:hover { transform: none; } }
/* A note under its line where the board reads the numbers: the money item, the screen, paper */
.ln-note { margin: 0; padding: 0.35rem 0.7rem 0.4rem; border-left: 3px solid var(--yellow, #FFDA24); background: var(--yellow-wash, #FFFAE0); border-radius: 0 8px 8px 0; font-size: 0.88rem; line-height: 1.45; color: var(--ink, #2D2F2C); white-space: pre-wrap; overflow-wrap: anywhere; text-align: left; font-weight: 450; }
.ln-note__by { color: var(--muted, #5F615A); font-size: 0.92em; white-space: nowrap; }
.ln-note__by::before { content: "· "; }
.bp-stmt__note td { padding: 0 0.5rem 0.55rem calc(var(--d, 0) * 1.1rem) !important; border-bottom: 1px solid var(--line); text-align: left; }
.bp-stmt__noted th, .bp-stmt__noted td { border-bottom-color: transparent !important; }
.bp-stmts__n { display: inline-grid; place-items: center; min-width: 1.15rem; height: 1.15rem; margin-left: 0.35rem; padding: 0 0.25rem; border-radius: 999px; background: var(--yellow); color: #1E1F1C; font-size: 0.7rem; font-weight: 750; vertical-align: 0.05em; }
@media (max-width: 640px) { .bp-stmt__table tr.bp-stmt__note { display: block; padding: 0 0 0.5rem; } .bp-stmt__note td { display: block; padding-left: calc(var(--d, 0) * 0.75rem) !important; } }
.by-stmt__note td { padding: 0 0 0.6em calc(var(--d, 0) * 1.2em); text-align: left; }
.by-stmt__note .ln-note { background: rgba(255, 218, 36, 0.12); color: inherit; font-size: 0.8em; }
.by-stmt__note .ln-note__by { color: inherit; opacity: 0.75; }
.bpp-stmt__note td { padding: 0 0 4pt; font-size: 9pt; font-style: italic; text-align: left; }
`;
if (typeof document !== 'undefined' && !document.getElementById('board-review-css')) {
  const s = document.createElement('style');
  s.id = 'board-review-css';
  s.textContent = CSS;
  document.head.append(s);
}
