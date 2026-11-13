/**
 * The schedule window: a job's JobTread schedule in the chat, changed with a tap and saved with one button
 * ===========================================================================
 * Peter, Nov 13 2026: "what other interactive windows can we [build] for updating projects", then yes to this one.
 * Claude opens it (functions/api/_mcp/field.js: job_tasks, and change_task / add_task with their result) on a job's
 * tasks: late ones first, then week by week, then those with no date yet, and what's done folded away.
 *
 * Nothing changes in JobTread until they press Save. A tap on a task opens it: new dates (a new start keeps its
 * length, and quick buttons move it a day or a week), done, who it's on, its name. The circle beside a task ticks it
 * done (or, on a done one, not done), several at once, and one Save puts them all in JobTread. Saving goes through
 * Claude (task_changes, the window's own tool), as the person, so JobTread shows their name and tells the people on
 * the task; tasks linked after a moved one move with it, as in JobTread, and the window names them. The last save
 * can be undone. Claude is told what was saved here, so the chat carries on from it.
 *
 * Its name in the file: schedule-<version>.js, because /mcp-app/ is cached for a year.
 */

const STYLE = `
.sc { --fg: var(--color-text-primary, #1f1d1a); --muted: var(--color-text-secondary, #5f5a54); --line: var(--color-border-primary, rgba(0,0,0,.14));
  --bg: var(--color-background-primary, #fff); --soft: var(--color-background-secondary, #f4f2ee); --ink: #1f1d1a; --on-ink: #fff;
  --late: #a15c00; --late-bg: #fdf3d9; --late-fg: #6b4300; --mark: #e8a33d;
  color: var(--fg); font: 15px/1.45 var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif); display: grid; gap: 12px; padding: 14px; }
:root[data-theme="dark"] .sc { --fg: var(--color-text-primary, #f2efe9); --muted: var(--color-text-secondary, #b4ada4); --line: var(--color-border-primary, rgba(255,255,255,.16));
  --bg: var(--color-background-primary, #1d1c1a); --soft: var(--color-background-secondary, #2a2926); --ink: #f2efe9; --on-ink: #1d1c1a;
  --late: #f0b24a; --late-bg: #3a2c0c; --late-fg: #f6d58e; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .sc { --fg: var(--color-text-primary, #f2efe9); --muted: var(--color-text-secondary, #b4ada4);
  --line: var(--color-border-primary, rgba(255,255,255,.16)); --bg: var(--color-background-primary, #1d1c1a); --soft: var(--color-background-secondary, #2a2926);
  --ink: #f2efe9; --on-ink: #1d1c1a; --late: #f0b24a; --late-bg: #3a2c0c; --late-fg: #f6d58e; } }
.sc * { box-sizing: border-box; }
.sc button, .sc input { font: inherit; color: inherit; }
.sc-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; }
.sc-kicker { font-size: 12px; color: var(--muted); }
.sc-title { font-weight: 650; font-size: 16px; overflow-wrap: anywhere; }
.sc-sub { font-size: 13px; color: var(--muted); }
.sc-tools { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.sc-tool { min-height: 36px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); padding: 0 10px; font-size: 13px; font-weight: 600;
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.sc-wait { color: var(--muted); font-size: 14px; }
/* A phone: the header's buttons are their pictures (each keeps its name for a screen reader), so the job's name has the room */
@media (max-width: 480px) { .sc-head .sc-tool { width: 40px; height: 40px; padding: 0; justify-content: center; } .sc-head .sc-tool span { display: none; } .sc-head .sc-tool svg { width: 18px; height: 18px; } }
.sc-groups { display: grid; gap: 14px; }
.sc-group { display: grid; gap: 4px; }
.sc-gh { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.sc-gname { font-weight: 650; font-size: 14px; }
.sc-gname small { font-weight: 400; color: var(--muted); font-size: 13px; }
.sc-group[data-g="late"] .sc-gname { color: var(--late); }
.sc-gnote { font-size: 13px; color: var(--muted); }
.sc-list { list-style: none; margin: 0; padding: 0; display: grid; }
.sc-row { display: grid; grid-template-columns: 44px minmax(0, 1fr); align-items: start; border-bottom: 1px solid var(--line); }
.sc-row:last-child { border-bottom: 0; }
.sc-tick { width: 44px; min-height: 48px; border: 0; background: none; display: flex; align-items: flex-start; justify-content: center; padding-top: 13px; cursor: pointer; }
.sc-tick span { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--muted); display: flex; align-items: center; justify-content: center; }
.sc-tick[data-done="true"] span { background: var(--fg); border-color: var(--fg); color: var(--bg); }
.sc-tick[data-pending="true"] span { border-color: var(--mark); border-style: dashed; }
.sc-tick[data-pending="true"][data-done="true"] span { background: var(--mark); border-color: var(--mark); border-style: solid; color: #1f1d1a; }
.sc-main { border: 0; background: none; text-align: left; padding: 10px 4px 10px 0; display: grid; gap: 1px; min-height: 48px; cursor: pointer; width: 100%; }
.sc-name { font-weight: 600; overflow-wrap: anywhere; }
.sc-row[data-done="true"] .sc-name { color: var(--muted); font-weight: 500; }
.sc-when { font-size: 13px; color: var(--muted); }
.sc-when.sc-late { color: var(--late); font-weight: 600; }
.sc-who { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.sc-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.sc-tags:empty { display: none; }
.sc-tag { font-size: 11px; font-weight: 700; letter-spacing: .02em; padding: 1px 7px; border-radius: 999px; background: var(--soft); color: var(--muted); }
.sc-tag.sc-now { background: var(--ink); color: var(--on-ink); }
.sc-tag.sc-unsaved { background: var(--mark); color: #1f1d1a; }
.sc-tag.sc-saved { border: 1px solid var(--line); background: none; color: var(--fg); }
.sc-more { justify-self: start; border: 0; background: none; color: var(--fg); text-decoration: underline; font-size: 13px; padding: 8px 0; cursor: pointer; min-height: 36px; }
.sc-edit { grid-column: 1 / -1; background: var(--soft); border-radius: 12px; padding: 12px; margin: 0 0 10px; display: grid; gap: 10px; }
.sc-edit:focus { outline: none; }
.sc-f { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
.sc-f input[type="text"], .sc-f input[type="date"] { min-height: 44px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); padding: 0 10px; font-size: 15px; width: 100%; min-width: 0; }
.sc-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.sc-shift { display: flex; gap: 6px; flex-wrap: wrap; }
.sc-chip { min-height: 36px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg); padding: 0 12px; font-size: 13px; cursor: pointer; }
.sc-chip[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); font-weight: 600; }
.sc-chip[disabled] { opacity: .5; cursor: default; }
.sc-check { display: flex; align-items: center; gap: 10px; min-height: 40px; font-size: 15px; color: var(--fg); cursor: pointer; }
.sc-check input { width: 20px; height: 20px; margin: 0; accent-color: var(--ink); }
.sc-who-l { font-size: 13px; color: var(--muted); }
.sc-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.sc-sum { font-size: 14px; }
.sc-sum:empty { display: none; }
.sc-problem { background: var(--late-bg); color: var(--late-fg); border-radius: 10px; padding: 10px 12px; font-size: 14px; }
.sc-problem:empty { display: none; }
.sc-btns { display: flex; gap: 10px; }
.sc-btns .sc-btn { flex: 1 1 0; min-width: 0; }
.sc-btn { min-height: 48px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg); font-weight: 600; padding: 0 12px; cursor: pointer; }
.sc-btn.sc-primary { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
.sc-btn[disabled] { opacity: .5; cursor: default; }
.sc-bar { border: 1px solid var(--line); border-radius: 12px; padding: 12px; display: grid; gap: 10px; background: var(--bg); }
.sc-bar-t { font-weight: 600; font-size: 14px; }
.sc-bar-s { font-size: 13px; color: var(--muted); }
.sc-note { border-radius: 12px; padding: 10px 12px; font-size: 14px; background: var(--soft); display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.sc-note.sc-warn { background: var(--late-bg); color: var(--late-fg); }
.sc-note .sc-tool { flex: none; }
.sc-foot { display: flex; gap: 8px; flex-wrap: wrap; }
.sc-empty { color: var(--muted); font-size: 14px; padding: 6px 0; }
.sc-row > .sc-note { grid-column: 1 / -1; margin: 0 0 10px; }
.sc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.sc button:focus-visible, .sc input:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.sc [disabled] { cursor: default; }
[hidden] { display: none !important; }
`;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ms = (d) => Date.parse(`${d}T12:00:00Z`);
export const addDays = (d, n) => new Date(ms(d) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((ms(b) - ms(a)) / 86400000);
/** Monday of that day's week */
export const weekOf = (d) => addDays(d, -((new Date(ms(d)).getUTCDay() + 6) % 7));
/** "Thu Nov 26" (with the year when it isn't this one) */
export function dayLabel(d, today = '') {
  if (!DAY.test(String(d || ''))) return '';
  const t = new Date(ms(d));
  const year = today && today.slice(0, 4) !== d.slice(0, 4) ? `, ${t.getUTCFullYear()}` : '';
  return `${DAYS[t.getUTCDay()]} ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}${year}`;
}
/** "Mon Nov 17", or "Thu Nov 26 to Mon Nov 30" */
export function spanLabel(start, end, today = '') {
  const a = start || end;
  const b = end || start;
  if (!a) return '';
  return a === b ? dayLabel(a, today) : `${dayLabel(a, today)} to ${dayLabel(b, today)}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const listOf = (names) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** Where a task sits: late, a week (its Monday), no date yet, or done */
export function groupOf(t, today) {
  if (t.done) return 'done';
  const s = t.start || t.end;
  const e = t.end || t.start;
  if (!s) return 'nodate';
  if (e < today) return 'late';
  // Started before this week and still going: it's this week's
  return s < weekOf(today) ? weekOf(today) : weekOf(s);
}

/** The schedule in groups, in order → [{ key, label, sub, tasks }] */
export function groups(view) {
  const today = view.today;
  const by = new Map();
  for (const t of view.tasks || []) {
    const g = groupOf(t, today);
    if (!by.has(g)) by.set(g, []);
    by.get(g).push(t);
  }
  const order = (a, b) => String(a.start || a.end || '').localeCompare(String(b.start || b.end || '')) || String(a.end || '').localeCompare(String(b.end || '')) || a.name.localeCompare(b.name);
  const thisWeek = weekOf(today);
  const out = [];
  if (by.has('late')) out.push({ key: 'late', label: 'Late', sub: 'Their dates have passed and they aren’t done', tasks: by.get('late').sort((a, b) => String(a.end || a.start).localeCompare(String(b.end || b.start)) || a.name.localeCompare(b.name)) });
  for (const k of [...by.keys()].filter((k) => DAY.test(k)).sort()) {
    const n = daysBetween(thisWeek, k) / 7;
    const label = n === 0 ? 'This week' : n === 1 ? 'Next week' : `Week of ${dayLabel(k, today)}`;
    const sun = addDays(k, 6);
    const sub = `${MONTHS[new Date(ms(k)).getUTCMonth()]} ${new Date(ms(k)).getUTCDate()} to ${k.slice(5, 7) === sun.slice(5, 7) ? '' : `${MONTHS[new Date(ms(sun)).getUTCMonth()]} `}${new Date(ms(sun)).getUTCDate()}`;
    out.push({ key: k, label, sub, tasks: by.get(k).sort(order) });
  }
  if (by.has('nodate')) out.push({ key: 'nodate', label: 'No date yet', sub: '', tasks: by.get('nodate').sort((a, b) => a.name.localeCompare(b.name)) });
  if (by.has('done')) out.push({ key: 'done', label: 'Done', sub: '', tasks: by.get('done').sort(order).reverse() });
  return out;
}

/** What a change does, in words: "moves to Fri Nov 20 to Sun Nov 22, on Christian Nielsen" */
export function changeWords(t, c, today = '') {
  const said = [];
  if (c.startDate !== undefined || c.endDate !== undefined) {
    const s = c.startDate ?? t.start;
    const e = c.endDate ?? t.end ?? s;
    said.push(`${t.start ? 'moves to' : 'gets the date'} ${spanLabel(s, e, today)}`);
  }
  if (c.done !== undefined) said.push(c.done ? 'done' : 'not done any more');
  if (c.assignees !== undefined) said.push(c.assignees.length ? `on ${listOf(c.assignees)}` : 'on nobody');
  if (c.name !== undefined) said.push(`renamed “${c.name}”`);
  return said.join(', ');
}

/** The change that puts a task back as it was before a save, or null when JobTread can't take it back from here */
export function undoOf(before, c) {
  const back = { taskId: c.taskId };
  if ((c.startDate !== undefined || c.endDate !== undefined) && before.start) {
    back.startDate = before.start;
    back.endDate = before.end || before.start;
  }
  if (c.done !== undefined) back.done = !!before.done;
  if (c.assignees !== undefined) back.assignees = before.who || [];
  if (c.name !== undefined) back.name = before.name;
  return Object.keys(back).length > 1 ? back : null;
}

const SHOW_LATE = 5;
const svg = (paths, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const CHECK = svg('<path d="M20 6 9 17l-5-5"></path>', 14);
const OUT = svg('<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>', 14);
const BIG = svg('<path d="M15 3h6v6"></path><path d="M9 21H3v-6"></path><path d="M21 3l-7 7"></path><path d="M3 21l7-7"></path>', 14);
const SMALL = svg('<path d="M4 14h6v6"></path><path d="M20 10h-6V4"></path><path d="M14 10l7-7"></path><path d="M3 21l7-7"></path>', 14);
const AGAIN = svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path>', 14);

/**
 * Put the schedule window in `root`.
 * opts: { save({ jobId, from, to, changes }) → { results: [{ taskId, ok, before, after, problem }], view },
 *         add({ job, name, startDate, endDate, assignees, todo }) → { task, view, changed },
 *         reload({ job, from, to }) → a view, openLink(url), tell(text), expand(), shrink() }
 * → { show(view, { changed }), loading(), waiting(text, action), setDisplay({ mode, modes }) }
 */
export function mountSchedule(root, opts) {
  if (!document.getElementById('sc-style')) {
    const s = document.createElement('style');
    s.id = 'sc-style';
    s.textContent = STYLE;
    document.head.append(s);
  }
  root.innerHTML = `<section class="sc" aria-label="A job’s schedule">
    <p class="sc-wait" data-r="wait">Getting the schedule…</p>
    <div class="sc-head" data-r="head" hidden>
      <div><div class="sc-kicker" data-r="kicker"></div><div class="sc-title" data-r="title"></div><div class="sc-sub" data-r="sub"></div></div>
      <div class="sc-tools">
        <button type="button" class="sc-tool" data-r="size" hidden></button>
        <button type="button" class="sc-tool" data-r="again" aria-label="Get the schedule again">${AGAIN}<span>Refresh</span></button>
      </div>
    </div>
    <div class="sc-sr" role="status" aria-live="polite" data-r="live"></div>
    <div data-r="topNote"></div>
    <div class="sc-groups" data-r="groups"></div>
    <div data-r="barNote"></div>
    <div class="sc-bar" data-r="bar" hidden>
      <div><div class="sc-bar-t" data-r="barT"></div><div class="sc-bar-s" data-r="barS"></div></div>
      <div class="sc-problem" data-r="barP"></div>
      <div class="sc-btns"><button type="button" class="sc-btn sc-primary" data-r="barSave">Save in JobTread</button><button type="button" class="sc-btn" data-r="barCancel">Cancel</button></div>
    </div>
    <div class="sc-foot" data-r="foot" hidden>
      <button type="button" class="sc-tool" data-r="addBtn">+ Add a task</button>
      <button type="button" class="sc-tool" data-r="jt">${OUT}<span>Open in JobTread</span></button>
    </div>
    <div data-r="addForm"></div>
  </section>`;
  const $ = (r) => root.querySelector(`[data-r="${r}"]`);
  const st = {
    view: null, ticks: new Map(), open: null, draft: null, adding: null, shown: new Set(), saved: new Set(), changed: new Set(),
    busy: false, note: null, told: [], display: { mode: 'inline', modes: [] },
  };
  const taskById = (id) => st.view?.tasks.find((t) => t.id === id);
  const show = (r, on) => { $(r).hidden = !on; };

  // ── Header, notes ──
  function head() {
    const v = st.view;
    show('wait', !v); show('head', !!v); show('foot', !!v);
    if (!v) return;
    $('kicker').textContent = `Schedule${v.as ? ` · as ${v.as}` : ''}`;
    $('title').textContent = v.job.name;
    $('sub').textContent = `Today is ${dayLabel(v.today)}`;
    const big = st.display.mode === 'fullscreen';
    const can = big || st.display.modes.includes('fullscreen');
    show('size', can && !!opts.expand);
    $('size').innerHTML = big ? `${SMALL}<span>Smaller</span>` : `${BIG}<span>Bigger</span>`;
    $('size').setAttribute('aria-label', big ? 'Back to the chat size' : 'Make the schedule bigger');
  }
  /** A line of news, where the person is looking: at: a task's id (under it), 'bar' (under the list) or 'top' */
  function setNote(text, { warn = false, undo = null, at = 'top', connect = '' } = {}) {
    st.note = text ? { text, warn, undo, at, connect } : null;
    $('live').textContent = text || '';
  }
  const noteHtml = (n) => `<div class="sc-note${n.warn ? ' sc-warn' : ''}"><span>${esc(n.text)}</span>${n.undo?.length ? `<button type="button" class="sc-tool" data-undo="1"${st.busy ? ' disabled' : ''}>Undo</button>` : ''}${n.connect ? `<button type="button" class="sc-tool" data-connect="${esc(n.connect)}">Connect JobTread</button>` : ''}</div>`;
  function placeNote() {
    const n = st.note;
    $('topNote').innerHTML = n && n.at === 'top' ? noteHtml(n) : '';
    // A note for a task that's folded away or gone goes under the list instead
    const under = n && n.at !== 'top' && n.at !== 'bar' && !root.querySelector(`.sc-row[data-id="${CSS.escape(n.at)}"]`);
    $('barNote').innerHTML = n && (n.at === 'bar' || under) ? noteHtml(n) : '';
  }

  // ── The list ──
  function whenOf(t) {
    const today = st.view.today;
    const span = spanLabel(t.start, t.end, today);
    if (!span) return { text: t.kind === 'to-do' ? 'To-do, no date' : 'No date yet', late: false };
    const g = groupOf(t, today);
    if (g === 'late') return { text: `Was due ${dayLabel(t.end || t.start, today)}`, late: true };
    const n = t.start && t.end ? daysBetween(t.start, t.end) + 1 : 1;
    return { text: n > 1 ? `${span} · ${n} days` : span, late: false };
  }
  function rowHtml(t) {
    const tick = st.ticks.has(t.id);
    const doneNow = tick ? st.ticks.get(t.id) : t.done;
    const w = whenOf(t);
    const today = st.view.today;
    const now = !t.done && t.start && t.start <= today && (t.end || t.start) >= today;
    const tags = [
      t.kind === 'to-do' ? '<span class="sc-tag">To-do</span>' : '',
      now ? '<span class="sc-tag sc-now">Today</span>' : '',
      tick ? '<span class="sc-tag sc-unsaved">Not saved</span>' : '',
      !tick && st.saved.has(t.id) ? '<span class="sc-tag sc-saved">Saved</span>' : '',
      !tick && !st.saved.has(t.id) && st.changed.has(t.id) ? '<span class="sc-tag sc-saved">Just changed</span>' : '',
    ].join('');
    const open = st.open === t.id;
    return `<li class="sc-row" data-id="${esc(t.id)}" data-done="${t.done}">
      <button type="button" class="sc-tick" data-tick="${esc(t.id)}" data-done="${doneNow}" data-pending="${tick}" aria-pressed="${doneNow}"
        aria-label="${esc(t.name)}: ${doneNow ? 'done' : 'not done'}${tick ? ' (not saved)' : ''}"${st.busy ? ' disabled' : ''}><span>${doneNow ? CHECK : ''}</span></button>
      <button type="button" class="sc-main" data-open="${esc(t.id)}" aria-expanded="${open}" aria-controls="sc-edit-${esc(t.id)}">
        <span class="sc-name">${esc(t.name)}</span>
        <span class="sc-when${w.late ? ' sc-late' : ''}">${esc(w.text)}</span>
        ${t.who?.length ? `<span class="sc-who">${esc(t.who.join(', '))}</span>` : ''}
        <span class="sc-tags">${tags}</span>
      </button>
      ${open ? editorHtml(t) : ''}
      ${st.note && st.note.at === t.id ? noteHtml(st.note) : ''}
    </li>`;
  }
  function groupHtml(g) {
    const folded = (g.key === 'nodate' || g.key === 'done') && !st.shown.has(g.key);
    const cap = g.key === 'late' && !st.shown.has('late') ? SHOW_LATE : Infinity;
    // A task being changed, ticked, just saved or just changed in the chat is never folded away
    const keep = (t) => st.open === t.id || st.ticks.has(t.id) || st.saved.has(t.id) || st.changed.has(t.id);
    const list = folded ? g.tasks.filter(keep) : g.tasks.filter((t, i) => i < cap || keep(t));
    const hidden = g.tasks.length - list.length;
    const more = hidden > 0
      ? `<button type="button" class="sc-more" data-more="${g.key}">${folded ? `Show ${g.tasks.length === 1 ? 'it' : `all ${g.tasks.length}`}` : `Show ${hidden} more`}</button>`
      : (g.key === 'late' || g.key === 'nodate' || g.key === 'done') && st.shown.has(g.key) && (g.key !== 'late' || g.tasks.length > SHOW_LATE)
        ? `<button type="button" class="sc-more" data-less="${g.key}">Show fewer</button>` : '';
    return `<div class="sc-group" data-g="${g.key === 'late' || g.key === 'nodate' || g.key === 'done' ? g.key : 'week'}">
      <div class="sc-gh"><div class="sc-gname">${esc(g.label)} <small>${g.tasks.length}${g.sub ? ` · ${esc(g.sub)}` : ''}</small></div></div>
      ${list.length ? `<ul class="sc-list">${list.map(rowHtml).join('')}</ul>` : ''}
      ${more}
    </div>`;
  }
  function paint() {
    head();
    const v = st.view;
    if (!v) return;
    const gs = groups(v);
    $('groups').innerHTML = gs.length
      ? gs.map(groupHtml).join('')
      : `<p class="sc-empty">Nothing on the schedule from ${esc(dayLabel(v.from, v.today))} to ${esc(dayLabel(v.to, v.today))}.</p>`;
    if (st.open) fillEditor();
    placeNote();
    bar();
    $('addBtn').disabled = st.busy;
    $('again').disabled = st.busy;
  }

  // ── Ticks: done (or not done) for several at once, saved together ──
  function bar() {
    const n = st.ticks.size;
    show('bar', n > 0);
    if (!n) return;
    const on = [...st.ticks.values()].filter(Boolean).length;
    const off = n - on;
    $('barT').textContent = [on ? `${on} marked done` : '', off ? `${off} marked not done` : ''].filter(Boolean).join(', ');
    $('barS').textContent = 'Nothing changes in JobTread until you save. JobTread lets the people on them know.';
    $('barSave').disabled = st.busy;
    $('barCancel').disabled = st.busy;
    $('barSave').textContent = st.busy && st.saving === 'ticks' ? 'Saving…' : n === 1 ? 'Save in JobTread' : `Save ${n} in JobTread`;
  }
  function tick(id) {
    const t = taskById(id);
    if (!t || st.busy) return;
    if (st.ticks.has(id)) st.ticks.delete(id);
    else st.ticks.set(id, !t.done);
    $('barP').textContent = '';
    paint();
    root.querySelector(`[data-tick="${CSS.escape(id)}"]`)?.focus();
  }

  // ── One task, opened ──
  function editorHtml(t) {
    const id = esc(t.id);
    return `<div class="sc-edit" id="sc-edit-${id}" tabindex="-1" role="group" aria-label="Change ${esc(t.name)}">
      <label class="sc-f">Name<input type="text" data-f="name" maxlength="200" autocomplete="off"></label>
      <div class="sc-two">
        <label class="sc-f">Starts<input type="date" data-f="start"></label>
        <label class="sc-f">Ends<input type="date" data-f="end"></label>
      </div>
      <div class="sc-shift" role="group" aria-label="Move it">
        <button type="button" class="sc-chip" data-shift="-1">1 day earlier</button>
        <button type="button" class="sc-chip" data-shift="1">1 day later</button>
        <button type="button" class="sc-chip" data-shift="7">1 week later</button>
      </div>
      <label class="sc-check"><input type="checkbox" data-f="done">Done</label>
      <div><div class="sc-who-l">Who it’s on</div><div class="sc-chips" data-f="who" role="group" aria-label="Who it’s on"></div></div>
      <div class="sc-sum" data-f="sum"></div>
      <div class="sc-problem" data-f="problem"></div>
      <div class="sc-btns"><button type="button" class="sc-btn sc-primary" data-f="save">Save in JobTread</button><button type="button" class="sc-btn" data-f="cancel">Cancel</button></div>
    </div>`;
  }
  const ed = (f) => root.querySelector(`.sc-edit [data-f="${f}"]`);
  function openTask(id) {
    if (st.busy) return;
    if (st.open === id) return closeTask();
    const t = taskById(id);
    if (!t) return;
    st.adding = null;
    $('addForm').replaceChildren();
    st.open = id;
    st.draft = { name: t.name, start: t.start || '', end: t.end || '', done: t.done, who: [...(t.who || [])], problem: '' };
    paint();
    root.querySelector('.sc-edit')?.focus({ preventScroll: true });
    root.querySelector('.sc-edit')?.scrollIntoView?.({ block: 'nearest' });
  }
  function closeTask() {
    const id = st.open;
    st.open = null;
    st.draft = null;
    paint();
    if (id) root.querySelector(`[data-open="${CSS.escape(id)}"]`)?.focus();
  }
  /** The change the open task's fields make, or {} */
  function draftChange() {
    const t = taskById(st.open);
    const d = st.draft;
    if (!t || !d) return {};
    const c = {};
    if (d.start && d.start !== (t.start || '')) c.startDate = d.start;
    if (d.end && d.end !== (t.end || '')) c.endDate = d.end;
    if (c.startDate && !c.endDate && t.end) c.endDate = d.end || t.end;
    if (d.done !== t.done) c.done = d.done;
    if (!sameSet(d.who, t.who || [])) c.assignees = [...d.who];
    const n = d.name.replace(/\s+/g, ' ').trim();
    if (n && n !== t.name) c.name = n;
    return c;
  }
  function draftProblem() {
    const d = st.draft;
    if (d.start && d.end && d.end < d.start) return 'It can’t end before it starts.';
    if (!d.name.trim()) return 'A task needs a name.';
    return '';
  }
  function fillEditor() {
    const t = taskById(st.open);
    const d = st.draft;
    if (!t || !d || !ed('name')) return;
    ed('name').value = d.name;
    ed('start').value = d.start;
    ed('end').value = d.end;
    ed('done').checked = d.done;
    const people = [...new Set([...(st.view.team || []), ...(t.who || [])])];
    ed('who').innerHTML = people.length
      ? people.map((n) => `<button type="button" class="sc-chip" data-who="${esc(n)}" aria-pressed="${d.who.includes(n)}">${esc(n)}</button>`).join('')
      : '<span class="sc-who-l">No one on SOARD’s team came back from JobTread.</span>';
    for (const b of root.querySelectorAll('[data-shift]')) b.disabled = !d.start || st.busy;
    refreshEditor();
  }
  function refreshEditor() {
    const t = taskById(st.open);
    if (!t || !ed('sum')) return;
    const c = draftChange();
    const problem = draftProblem();
    const words = Object.keys(c).length ? changeWords(t, c, st.view.today) : '';
    const moved = c.startDate !== undefined || c.endDate !== undefined;
    ed('sum').textContent = problem ? '' : words ? `${t.name} ${words}.${moved ? ' Tasks linked after it in JobTread move with it.' : ''}` : '';
    ed('problem').textContent = problem || st.draft.problem || '';
    ed('save').disabled = st.busy || !!problem || !words;
    ed('save').textContent = st.busy && st.saving === 'task' ? 'Saving…' : 'Save in JobTread';
    ed('cancel').disabled = st.busy;
    for (const el of root.querySelectorAll('.sc-edit input, .sc-edit .sc-chip')) if (!el.dataset.shift) el.disabled = st.busy;
  }
  function setStart(v) {
    const d = st.draft;
    if (!DAY.test(v)) { ed('start').value = d.start; return; }
    // A new start keeps how long it takes (the task's own length when the end typed in came before the start)
    const t = taskById(st.open);
    const len = d.start && d.end && d.end >= d.start ? daysBetween(d.start, d.end) : t?.start && t?.end ? daysBetween(t.start, t.end) : 0;
    d.start = v;
    d.end = addDays(v, Math.max(0, len));
    fillEditor();
  }

  // ── Saving ──
  async function save(changes, { undoing = false, from = 'task' } = {}) {
    if (st.busy || !changes.length || !st.view) return;
    const before = st.view;
    st.busy = true;
    st.saving = from;
    const at = from === 'task' ? changes[0].taskId : undoing ? (st.note?.at || 'bar') : 'bar';
    if (from === 'task' && st.draft) st.draft.problem = '';
    else setNote(undoing ? 'Putting it back in JobTread…' : 'Saving in JobTread…', { at });
    paint();
    let r;
    try {
      r = await opts.save({ jobId: before.job.id, from: before.from, to: before.to, changes });
    } catch (err) {
      st.busy = false;
      const why = err?.message || 'JobTread didn’t take it. Try again.';
      if (err?.connect) { if (st.draft) st.draft.problem = ''; $('barP').textContent = ''; setNote(why, { warn: true, at: from === 'task' ? changes[0].taskId : 'bar', connect: err.connect }); }
      else if (from === 'task' && st.draft) { st.draft.problem = why; setNote(''); }
      else if (from === 'ticks') { $('barP').textContent = why; setNote(''); }
      else setNote(why, { warn: true, at });
      paint();
      return;
    }
    st.busy = false;
    const results = r?.results || [];
    const ok = results.filter((x) => x.ok);
    const bad = results.filter((x) => !x.ok);
    const named = (id) => before.tasks.find((t) => t.id === id) || r?.view?.tasks.find((t) => t.id === id);
    const lines = ok.map((x) => { const c = changes.find((y) => y.taskId === x.taskId) || {}; return `${named(x.taskId)?.name || 'A task'} ${changeWords(named(x.taskId) || {}, c, before.today)}`; });
    // Tasks linked after a moved one moved too: name them
    const touched = new Set(changes.map((c) => c.taskId));
    const also = (r?.view?.tasks || []).filter((t) => {
      if (touched.has(t.id)) return false;
      const was = before.tasks.find((x) => x.id === t.id);
      return was && (was.start !== t.start || was.end !== t.end);
    }).map((t) => t.name);
    if (from === 'ticks') { for (const x of ok) st.ticks.delete(x.taskId); $('barP').textContent = bad.length ? bad.map((x) => `${named(x.taskId)?.name || 'A task'}: ${x.problem}`).join(' ') : ''; }
    if (from === 'task') {
      if (bad.length) st.draft.problem = bad[0].problem;
      else { st.open = null; st.draft = null; }
    }
    st.saved = new Set(ok.map((x) => x.taskId));
    st.changed = new Set();
    if (r?.view) st.view = r.view;
    // Done, and from before the list's days (an old late one ticked done): it stays in view under Done, saved, with its Undo
    if (r?.view) for (const x of ok) if (x.after && !st.view.tasks.some((t) => t.id === x.taskId)) st.view.tasks.push({ ...x.after });
    const undo = undoing ? null : ok.map((x) => undoOf(x.before || {}, changes.find((c) => c.taskId === x.taskId) || {})).filter(Boolean);
    if (ok.length) {
      const text = `${undoing ? 'Put back' : 'Saved'} in JobTread: ${lines.join('; ')}.${also.length ? ` Also moved, linked after it: ${listOf(also.slice(0, 6))}${also.length > 6 ? ` and ${also.length - 6} more` : ''}.` : ''}${bad.length && from !== 'task' ? ` ${bad.length} didn’t save.` : ''}`;
      setNote(text, { undo, at: from === 'task' && !bad.length ? changes[0].taskId : at });
      told(`${undoing ? 'Undid the last change' : 'Saved'}: ${lines.join('; ')}${also.length ? ` (also moved, linked after it: ${also.join(', ')})` : ''}.`);
    } else setNote('');
    paint();
    // Focus stays where they were: the task they saved, or the news under the list (the Save bar has gone)
    if (from === 'task' && !st.open) root.querySelector(`[data-open="${CSS.escape(changes[0].taskId)}"]`)?.focus({ preventScroll: true });
    else if (from !== 'task') root.querySelector('[data-r="barNote"] button, [data-r="barNote"] .sc-note')?.focus?.({ preventScroll: true });
  }
  /** Claude hears what was saved here, every save so far, so the chat carries on from it */
  function told(line) {
    st.told.push(line);
    const v = st.view;
    opts.tell?.(`In the schedule window for ${v.job.name} (JobTread job ${v.job.id}), ${v.as || 'the person'} saved these in JobTread themselves. They’re done: don’t make them again.\n${st.told.slice(-12).map((l) => `- ${l}`).join('\n')}`);
  }

  // ── Adding a task ──
  function addForm() {
    if (st.busy || !st.view) return;
    st.open = null;
    st.draft = null;
    st.adding = { name: '', start: '', end: '', who: [], todo: false, problem: '' };
    paint();
    const team = st.view.team || [];
    const f = $('addForm');
    f.innerHTML = `<div class="sc-edit" tabindex="-1" role="group" aria-label="Add a task">
      <label class="sc-f">What’s the task?<input type="text" data-a="name" maxlength="200" autocomplete="off"></label>
      <label class="sc-check"><input type="checkbox" data-a="todo">A to-do (it doesn’t need dates)</label>
      <div class="sc-two"><label class="sc-f">Starts<input type="date" data-a="start"></label><label class="sc-f">Ends<input type="date" data-a="end"></label></div>
      <div><div class="sc-who-l">Who it’s on</div><div class="sc-chips" role="group" aria-label="Who it’s on">${team.map((n) => `<button type="button" class="sc-chip" data-awho="${esc(n)}" aria-pressed="false">${esc(n)}</button>`).join('')}</div></div>
      <div class="sc-problem" data-a="problem"></div>
      <div class="sc-btns"><button type="button" class="sc-btn sc-primary" data-a="go" disabled>Add to JobTread</button><button type="button" class="sc-btn" data-a="cancel">Cancel</button></div>
    </div>`;
    const a = (k) => f.querySelector(`[data-a="${k}"]`);
    const sync = () => {
      const s = st.adding;
      const problem = s.start && s.end && s.end < s.start ? 'It can’t end before it starts.' : '';
      a('problem').textContent = problem || s.problem;
      a('go').disabled = st.busy || !s.name.trim() || !!problem;
      a('go').textContent = st.busy ? 'Adding…' : 'Add to JobTread';
    };
    a('name').oninput = (e) => { st.adding.name = e.target.value; sync(); };
    a('todo').onchange = (e) => { st.adding.todo = e.target.checked; sync(); };
    a('start').onchange = (e) => { st.adding.start = e.target.value; if (st.adding.start && (!st.adding.end || st.adding.end < st.adding.start)) { st.adding.end = st.adding.start; a('end').value = st.adding.end; } sync(); };
    a('end').onchange = (e) => { st.adding.end = e.target.value; sync(); };
    for (const b of f.querySelectorAll('[data-awho]')) b.onclick = () => {
      const n = b.dataset.awho;
      const w = st.adding.who;
      if (w.includes(n)) w.splice(w.indexOf(n), 1); else w.push(n);
      b.setAttribute('aria-pressed', String(w.includes(n)));
    };
    a('cancel').onclick = () => { st.adding = null; f.replaceChildren(); $('addBtn').focus(); };
    a('go').onclick = async () => {
      const s = st.adding;
      if (!s?.name.trim() || st.busy) return;
      st.busy = true;
      s.problem = '';
      sync();
      paint();
      try {
        const r = await opts.add({ job: st.view.job.id, name: s.name.trim(), ...(s.start ? { startDate: s.start } : {}), ...(s.end ? { endDate: s.end } : {}), ...(s.who.length ? { assignees: s.who } : {}), ...(s.todo ? { todo: true } : {}) });
        st.busy = false;
        st.adding = null;
        f.replaceChildren();
        if (r?.view) st.view = r.view;
        const t = r?.task || {};
        st.saved = new Set(t.id ? [t.id] : []);
        st.changed = new Set();
        const when = spanLabel(t.start, t.end, st.view.today);
        setNote(`Added to JobTread: ${t.name || s.name.trim()}${when ? ` on ${when}` : ''}${t.who?.length ? `, on ${listOf(t.who)}` : ''}.`, { at: t.id || 'bar' });
        told(`Added the ${t.kind === 'to-do' ? 'to-do' : 'task'} “${t.name || s.name.trim()}”${when ? ` on ${when}` : ''}${t.who?.length ? `, on ${listOf(t.who)}` : ''}.`);
        paint();
      } catch (err) {
        st.busy = false;
        s.problem = err?.connect ? '' : err?.message || 'JobTread didn’t add it. Try again.';
        if (err?.connect) setNote(err.message, { warn: true, at: 'bar', connect: err.connect });
        paint();
        sync();
      }
    };
    sync();
    f.querySelector('.sc-edit').focus({ preventScroll: true });
    f.querySelector('.sc-edit').scrollIntoView?.({ block: 'nearest' });
  }

  // ── Events (one listener for the whole window) ──
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !root.contains(b)) return;
    if (b.dataset.undo && st.note?.undo?.length) return save(st.note.undo, { undoing: true, from: 'undo' });
    if (b.dataset.connect) return opts.openLink?.(b.dataset.connect);
    if (b.dataset.tick) return tick(b.dataset.tick);
    if (b.dataset.open) return openTask(b.dataset.open);
    if (b.dataset.more) { st.shown.add(b.dataset.more); return paint(); }
    if (b.dataset.less) { st.shown.delete(b.dataset.less); return paint(); }
    if (b.dataset.shift && st.draft?.start) {
      const n = Number(b.dataset.shift);
      st.draft.start = addDays(st.draft.start, n);
      if (st.draft.end) st.draft.end = addDays(st.draft.end, n);
      return fillEditor();
    }
    if (b.dataset.who && st.draft) {
      const w = st.draft.who;
      const n = b.dataset.who;
      if (w.includes(n)) w.splice(w.indexOf(n), 1); else w.push(n);
      b.setAttribute('aria-pressed', String(w.includes(n)));
      return refreshEditor();
    }
    const f = b.dataset.f;
    if (f === 'cancel') return closeTask();
    if (f === 'save') { const c = draftChange(); if (Object.keys(c).length && !draftProblem()) save([{ taskId: st.open, ...c }], { from: 'task' }); return; }
    const r = b.dataset.r;
    if (r === 'barSave') return save([...st.ticks].map(([taskId, done]) => ({ taskId, done })), { from: 'ticks' });
    if (r === 'barCancel') { st.ticks.clear(); $('barP').textContent = ''; return paint(); }
    if (r === 'addBtn') return addForm();
    if (r === 'jt') return st.view && opts.openLink?.(st.view.job.schedule);
    if (r === 'again') return reload();
    if (r === 'size') return resize();
  });
  root.addEventListener('input', (e) => {
    const f = e.target.dataset?.f;
    if (!st.draft) return;
    if (f === 'name') { st.draft.name = e.target.value; refreshEditor(); }
  });
  root.addEventListener('change', (e) => {
    const f = e.target.dataset?.f;
    if (!st.draft || !f) return;
    if (f === 'start') return setStart(e.target.value);
    if (f === 'end') { if (DAY.test(e.target.value)) st.draft.end = e.target.value; else e.target.value = st.draft.end; return refreshEditor(); }
    if (f === 'done') { st.draft.done = e.target.checked; return refreshEditor(); }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (st.open && !st.busy) { e.preventDefault(); closeTask(); }
    else if (st.adding && !st.busy) { e.preventDefault(); st.adding = null; $('addForm').replaceChildren(); $('addBtn').focus(); }
  });

  async function reload() {
    if (st.busy || !st.view || !opts.reload) return;
    st.busy = true;
    setNote('Getting the schedule again…', { at: 'top' });
    paint();
    try {
      const v = await opts.reload({ job: st.view.job.id, from: st.view.from, to: st.view.to });
      st.busy = false;
      setNote('');
      showView(v?.view || v, { keep: true });
    } catch (err) {
      st.busy = false;
      setNote(err?.message || 'The schedule didn’t come back. Try again.', { warn: true, at: 'top', connect: err?.connect || '' });
      paint();
    }
  }
  async function resize() {
    const big = st.display.mode === 'fullscreen';
    try {
      const r = await (big ? opts.shrink?.() : opts.expand?.());
      if (r?.mode) st.display.mode = r.mode;
    } catch { /* the host keeps its size */ }
    head();
  }

  function showView(view, { changed = [], keep = false } = {}) {
    if (!view?.job || !Array.isArray(view.tasks)) return;
    const sameJob = st.view?.job.id === view.job.id;
    st.view = view;
    // Ticks and an open task carry over only on the same job, and only for tasks still there
    if (!sameJob) { st.ticks.clear(); st.open = null; st.draft = null; st.adding = null; $('addForm').replaceChildren(); st.shown.clear(); st.told = []; }
    for (const id of [...st.ticks.keys()]) if (!taskById(id)) st.ticks.delete(id);
    if (st.open && !taskById(st.open)) { st.open = null; st.draft = null; }
    if (!keep) { st.changed = new Set(changed); st.saved = new Set(); if (changed.length) setNote(''); }
    paint();
  }

  return {
    show: (view, o) => showView(view, o),
    loading() { if (!st.view) { $('wait').textContent = 'Getting the schedule…'; show('wait', true); } },
    /** Before there's a schedule: a line of words, and a button when there's somewhere to go first (connect JobTread) */
    waiting(text, action) {
      if (st.view) { if (text) { setNote(text, { warn: true, at: 'top' }); paint(); } return; }
      $('wait').textContent = text || 'Tell Claude which job, and its schedule opens here.';
      show('wait', true);
      root.querySelector('.sc-first')?.remove();
      if (action?.url) {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'sc-btn sc-primary sc-first', textContent: action.label || 'Open' });
        b.onclick = () => opts.openLink?.(action.url);
        $('wait').after(b);
      }
    },
    setDisplay({ mode = 'inline', modes = [] } = {}) { st.display = { mode, modes }; head(); },
  };
}
