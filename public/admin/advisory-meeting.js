/**
 * Running the Advisory Board → Meetings
 * ===========================================================================
 * The list and one meeting's page, for whoever runs the group: in the staff
 * admin (Peter, Holly) and on the advisors' page (Mary Atchley, who signs in as
 * a board member), so it stands on its own: its own styles (am-), nothing from
 * either page's stylesheet, and every change through /api/advisory-admin.
 *
 * Like Board's meeting page it follows the date: ahead, the agenda beside the
 * presentation as it's written (the same screen the board's meetings use, drawn
 * by ./advisory/screen/), then getting it to advisors; held, the recap comes
 * first. It saves itself a moment after each change. Nobody takes attendance or
 * notes here, and the agenda starts from the template, never a blank page.
 * What the invite does is ../../functions/api/_advisory-meetings.js.
 */

import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';
import { viewerLink, sizeText } from './file-viewer.js';
import { longDate, shortDate, timeRange, todayEastern, isDate, uid, mergeMeeting, cleanMeeting } from './board-shared.js';

const html = htm.bind(h);
const fileUrl = (f) => `/api/advisory-file?id=${encodeURIComponent(f.id)}`;
const viewerFiles = (files) => files.map((f) => ({ name: f.name, type: f.type, size: f.size, at: f.at, url: fileUrl(f) }));
const SCREEN = '/admin/advisory/screen/';
const screenUrl = (id, mode, at = '') => `${SCREEN}?${mode}${at ? `&at=${encodeURIComponent(at)}` : ''}#/meetings/${encodeURIComponent(id)}/screen`;
const RECAP_KIND = 'minutes';
const FILE_OK = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.docx,.xlsx,.pptx,.doc,.xls';
const ANSWERS = { accepted: 'Coming', tentative: 'Maybe', declined: 'Can’t come', invited: 'Hasn’t answered' };

/** "Q1 2027 Advisory Board Meeting" (functions/api/_advisory-meetings.js advisoryName) */
function defaultName(m) {
  if (!isDate(m?.date)) return 'Advisory Board meeting';
  const [y, mo] = m.date.split('-').map(Number);
  return `Q${Math.ceil(mo / 3)} ${y} Advisory Board Meeting`;
}
const nameOf = (m) => String(m?.title || '').trim() || defaultName(m);
const TIMES_WRONG = 'A meeting has to end after it starts. Check the times.';
const timesWrong = (m) => !!(m.start && m.end && m.end <= m.start);
/** A whole date a meeting could be on: a year still being typed reads as 0202 */
const wholeDate = (d) => isDate(d) && Number(d.slice(0, 4)) >= 2000 && Number(d.slice(0, 4)) <= 2100;
const API = '/api/advisory-admin';

// What's typed and not saved yet, kept on this device, so a failed save, a reload or a closed tab never loses words.
// { base: the copy it started from, mine: what was typed }; gone once it's saved
const draftKey = (id) => `am-draft:${id}`;
const readDraft = (id) => { try { const d = JSON.parse(localStorage.getItem(draftKey(id)) || 'null'); return d?.mine && d?.base ? d : null; } catch { return null; } };
const keepDraft = (id, base, mine) => { try { localStorage.setItem(draftKey(id), JSON.stringify({ base, mine })); } catch { /* full, or private browsing */ } };
const dropDraft = (id) => { try { localStorage.removeItem(draftKey(id)); } catch { /* private browsing */ } };
/** What a person typed, to tell whether a kept draft says anything the meeting doesn't */
const typed = (m) => JSON.stringify([m.date, m.start, m.end, m.title, m.location, m.address, m.inviteNote, m.recap, (m.sections || []).map((s) => [s.title, s.minutes, s.items.map((i) => [i.title, i.who, i.report, i.docs])])]);
const heldBy = (m, today) => isDate(m.date) && m.date < today;

// ═══════════════════════════════════════════════════════════════════
// The list
// ═══════════════════════════════════════════════════════════════════

export function AdvisoryMeetings({ data, reload, call }) {
  addStyles();
  const [open, setOpen] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const today = data.today || todayEastern();
  const list = Array.isArray(data.meetings) ? data.meetings : [];
  const ahead = list.filter((m) => !heldBy(m, today)).sort((a, b) => a.date.localeCompare(b.date));
  const past = list.filter((m) => heldBy(m, today));
  const add = async (e) => {
    e.preventDefault();
    if (!date) { setNote('Pick the day first.'); return; }
    setBusy(true);
    const j = await call({ action: 'new-meeting', date });
    setBusy(false);
    if (!j.ok) { setNote(j.error || 'That didn’t save. Try again.'); return; }
    setNote('');
    setDate('');
    await reload();
    setOpen(j.meeting.id);
  };
  const meeting = open ? list.find((m) => m.id === open) : null;
  if (meeting) return html`<${Editor} key=${meeting.id} from=${meeting} data=${data} call=${call} reload=${reload} onBack=${() => setOpen('')} />`;
  return html`<div class="am">
    <form class="am-add" onSubmit=${add}>
      <label class="am-field"><span>New meeting</span><input type="date" value=${date} min=${today} onInput=${(e) => setDate(e.target.value)} /></label>
      <button type="submit" class="am-btn am-btn--main" disabled=${busy}>${busy ? 'Adding…' : 'Add meeting'}</button>
      ${note ? html`<p class="am-note" role="alert">${note}</p>` : null}
    </form>
    ${list.length ? null : html`<div class="am-card am-empty"><p class="am-empty__t">No meetings yet</p><p class="am-muted">Pick a day above. The agenda starts itself, and nothing reaches advisors until you send the invite and share it.</p></div>`}
    ${ahead.length ? html`<h3 class="am-h">Ahead</h3><ul class="am-list">${ahead.map((m) => html`<${Row} m=${m} key=${m.id} onOpen=${() => setOpen(m.id)} />`)}</ul>` : null}
    ${past.length ? html`<h3 class="am-h">Past</h3><ul class="am-list">${past.map((m) => html`<${Row} m=${m} key=${m.id} onOpen=${() => setOpen(m.id)} />`)}</ul>` : null}
  </div>`;
}

function Row({ m, onOpen }) {
  const words = [m.invite?.eventId ? 'Invite sent' : m.inviteGone ? 'Invite deleted' : 'No invite yet', m.shared ? 'On the page' : 'Not shared', ...(m.recapShared ? ['Recap shared'] : [])];
  return html`<li><button type="button" class="am-row" onClick=${onOpen}>
    <span class="am-tile"><b>${isDate(m.date) ? new Date(`${m.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) : ''}</b>${isDate(m.date) ? Number(m.date.slice(8)) : ''}</span>
    <span class="am-row__t"><strong>${nameOf(m)}</strong><span class="am-muted">${[timeRange(m.start, m.end), m.location].filter(Boolean).join(' · ')}</span></span>
    <span class="am-row__s">${words.join(' · ')}</span>
  </button></li>`;
}

// ═══════════════════════════════════════════════════════════════════
// One meeting
// ═══════════════════════════════════════════════════════════════════

const EDITED = ['date', 'start', 'end', 'title', 'location', 'address', 'inviteNote', 'sections', 'recap'];
const editable = (m) => ({ id: m.id, ...Object.fromEntries(EDITED.map((k) => [k, m[k]])) });
/** The files on each item, as the server has them, onto what's on the page: every typed word stays as it is */
const withDocs = (mine, saved) => {
  const by = new Map(saved.flatMap((s) => s.items).map((it) => [it.id, it.docs]));
  return mine.map((s) => ({ ...s, items: s.items.map((it) => (by.has(it.id) ? { ...it, docs: by.get(it.id) } : it)) }));
};
const SERVER = ['invite', 'inviteGone', 'shared', 'recapShared', 'files', 'updatedAt', 'updatedBy', 'replies', 'name'];
const serverPart = (j) => Object.fromEntries(SERVER.filter((k) => k in j).map((k) => [k, j[k]]));

function Editor({ from, data, call, reload, onBack }) {
  // Words left from last time (a failed save, a reload, a closed tab) come back, unless the meeting already says them
  const [draft] = useState(() => {
    const d = readDraft(from.id);
    if (d && typed({ ...from, ...d.mine }) === typed(from)) { dropDraft(from.id); return null; }
    return d;
  });
  const [m, setM] = useState(() => (draft ? { ...from, ...draft.mine } : from));
  const [save, setSave] = useState({ s: 'saved', error: '' });
  const [note, setNote] = useState(draft ? 'Your last changes hadn’t saved, so they’re back here.' : '');
  const [focusId, setFocusId] = useState('');
  const [leaving, setLeaving] = useState(false);
  const latest = useRef(m);
  latest.current = m;
  const base = useRef(draft ? draft.base : from); // the copy the server last gave: what a save starts from, and what a clash is worked out against
  const timer = useRef(0);
  const dirty = useRef(false);
  const saving = useRef(null);
  const today = data.today || todayEastern();
  const held = heldBy(m, today);

  const flush = () => {
    clearTimeout(timer.current);
    if (saving.current) return saving.current;
    if (!dirty.current) return Promise.resolve(true);
    // The times need fixing first (it says so beside them). What's typed is kept on this device meanwhile
    if (timesWrong(latest.current)) { setSave({ s: 'failed', error: TIMES_WRONG, held: true }); return Promise.resolve(false); }
    dirty.current = false;
    setSave({ s: 'saving', error: '' });
    const run = (async () => {
      const mine = latest.current;
      let j = await call({ action: 'save-meeting', meeting: editable(mine), base: base.current.updatedAt });
      // Saved by someone else meanwhile: item by item, mine and theirs together; the same thing changed both ways keeps mine
      if (!j.ok && j.status === 409 && j.current) {
        const { merged, clashes } = mergeMeeting(cleanMeeting(base.current), cleanMeeting(mine), cleanMeeting(j.current));
        const next = { ...mine, ...merged, recap: mine.recap !== base.current.recap ? mine.recap : j.current.recap };
        j = await call({ action: 'save-meeting', meeting: editable(next), base: j.current.updatedAt });
        if (j.ok) {
          setM((cur) => ({ ...cur, sections: next.sections, ...serverPart(j.meeting) }));
          setNote(clashes.length ? `Someone else saved at the same time. Yours was kept for ${clashes.join(', ')}.` : 'Someone else saved at the same time, and both sets of changes are in.');
        }
      }
      saving.current = null;
      if (j.ok) {
        base.current = j.meeting;
        setM((cur) => ({ ...cur, ...serverPart(j.meeting) }));
        setSave({ s: 'saved', error: '' });
        if (dirty.current) return flush();
        dropDraft(mine.id);
        return true;
      }
      dirty.current = true;
      setSave({ s: 'failed', error: j.error || 'That didn’t save.' });
      return false;
    })();
    saving.current = run;
    return run;
  };
  const edit = (patch) => {
    setM((cur) => {
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
      latest.current = next;
      keepDraft(next.id, base.current, editable(next));
      return next;
    });
    dirty.current = true;
    setSave((s) => (s.s === 'failed' && !s.held ? s : { s: 'waiting', error: '' }));
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 800);
  };
  useEffect(() => () => { clearTimeout(timer.current); if (dirty.current) flush(); }, []);
  // Words brought back: saved now, like any others
  useEffect(() => { if (draft) { dirty.current = true; flush(); } }, []);
  // Leaving the page: told first if anything's unsaved, and the last words sent on a request that outlives the page.
  // If that doesn't arrive either, the draft on this device brings them back next time
  useEffect(() => {
    const unsaved = () => dirty.current || !!saving.current;
    const warn = (e) => { if (unsaved()) { e.preventDefault(); e.returnValue = ''; } };
    const bye = () => {
      if (!dirty.current) return;
      clearTimeout(timer.current);
      try {
        fetch(API, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save-meeting', meeting: editable(latest.current), base: base.current.updatedAt }) }).catch(() => {});
      } catch { /* too large to outlive the page: the draft has it */ }
    };
    addEventListener('beforeunload', warn);
    addEventListener('pagehide', bye);
    return () => { removeEventListener('beforeunload', warn); removeEventListener('pagehide', bye); };
  }, []);
  /**
   * Something the server does (the invite, sharing, a file): what's typed goes first, then what it answers. Only what's
   * the server's comes back, so anything typed meanwhile stays. `here`: where a refusal shows, beside what was pressed
   */
  const act = async (body, { form = null, here = null } = {}) => {
    const say = here || setNote;
    say('');
    if (!(await flush())) {
      say(timesWrong(latest.current) ? TIMES_WRONG : 'Your changes haven’t saved yet, so that didn’t go through. Try again in a moment.');
      return null;
    }
    const j = form ? await call(null, { form }) : await call(body);
    if (!j.ok) { say(String(j.error || 'That didn’t go through. Try again.').replace(/\bBoard files\b/, 'Files')); return null; }
    if (j.meeting) {
      base.current = j.meeting;
      setM((cur) => {
        const next = { ...cur, ...serverPart(j.meeting), sections: withDocs(cur.sections, j.meeting.sections) };
        latest.current = next;
        return next;
      });
    }
    return j;
  };
  /** Back to the list, once everything's saved. A save that fails stays here and says so */
  const back = async () => {
    if (!(await flush())) { setLeaving(true); return; }
    await reload();
    onBack();
  };
  const leaveAnyway = async () => { dirty.current = false; await reload(); onBack(); };
  const retry = async () => { if (await flush()) setLeaving(false); };
  const remove = async (here) => {
    const j = await act({ action: 'delete-meeting', id: m.id }, { here });
    if (j) { dirty.current = false; dropDraft(m.id); await reload(); onBack(); }
  };

  const emailsOn = data.settings?.emails === true;
  const steps = [
    ['Agenda', m.sections.some((s) => s.items.some((it) => it.title)) ? 'done' : 'next'],
    ['Invite', m.invite?.eventId ? 'done' : emailsOn ? 'next' : 'ahead'],
    ['On the page', m.shared ? 'done' : 'next'],
    ['The meeting', held ? 'done' : 'ahead'],
    ['Recap', m.recapShared ? 'done' : held ? 'next' : 'ahead'],
  ];
  const recap = html`<${Recap} m=${m} edit=${edit} act=${act} held=${held} />`;
  return html`<div class="am">
    <div class="am-top">
      <button type="button" class="am-link" onClick=${back}>All meetings</button>
      <span class=${`am-saved is-${save.s}`} role="status">${save.s === 'saved' ? 'Saved' : save.s === 'failed' ? save.error : 'Saving…'}${save.s === 'failed' && !save.held ? html` <button type="button" class="am-link" onClick=${flush}>Try again</button>` : null}</span>
    </div>
    <label class="am-name"><span class="am-sr">The meeting’s name</span><input value=${m.title} placeholder=${defaultName(m)} maxlength="200" onInput=${(e) => edit({ title: e.target.value })} /></label>
    <ol class="am-steps" aria-label="Where this meeting stands">${steps.map(([t, s]) => html`<li class=${`is-${s}`} key=${t}>${t}</li>`)}</ol>
    ${leaving ? html`<div class="am-note am-stay" role="alert">
      <p class="am-strong">Your changes haven’t saved yet.</p>
      <p>Stay here and try again. If you leave, they’re kept on this device and come back when you open this meeting here.</p>
      <div class="am-stay__do"><button type="button" class="am-btn am-btn--main" onClick=${retry}>Try again</button><button type="button" class="am-link" onClick=${leaveAnyway}>Leave for now</button></div>
    </div>` : null}
    ${note ? html`<p class="am-note" role="alert">${note}</p>` : null}
    ${held ? recap : null}
    <div class="am-split">
      <div class="am-col">
        <${When} m=${m} edit=${edit} />
        <${Agenda} m=${m} data=${data} edit=${edit} act=${act} onFocus=${setFocusId} />
      </div>
      <${Stage} m=${m} focusId=${focusId} />
    </div>
    ${held ? null : html`<${GettingOut} m=${m} act=${act} emailsOn=${emailsOn} />`}
    ${held ? null : recap}
    <${Files} m=${m} act=${act} />
    <${Remove} m=${m} held=${held} onRemove=${remove} />
  </div>`;
}

/** The day: only a whole date reaches the meeting, so a year half typed never makes it look held. Left half typed, it goes back */
function DayField({ value, onDay }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  return html`<label class="am-field"><span>Day</span><input type="date" value=${text} onInput=${(e) => { setText(e.target.value); if (wholeDate(e.target.value)) onDay(e.target.value); }} onBlur=${() => setText(value)} /></label>`;
}

function When({ m, edit }) {
  return html`<section class="am-card" aria-labelledby="am-when"><h3 class="am-card__h" id="am-when">When and where</h3>
    <div class="am-grid">
      <${DayField} value=${m.date} onDay=${(date) => edit({ date })} />
      <label class="am-field"><span>Starts</span><input type="time" value=${m.start} onInput=${(e) => edit({ start: e.target.value })} /></label>
      <label class="am-field"><span>Ends</span><input type="time" value=${m.end} aria-invalid=${timesWrong(m)} onInput=${(e) => edit({ end: e.target.value })} /></label>
    </div>
    ${timesWrong(m) ? html`<p class="am-note" role="alert">${TIMES_WRONG}</p>` : null}
    <div class="am-grid am-grid--two">
      <label class="am-field"><span>Place</span><input value=${m.location} maxlength="200" placeholder="Leave blank for Google Meet only" onInput=${(e) => edit({ location: e.target.value })} /></label>
      <label class="am-field"><span>Address</span><input value=${m.address} maxlength="300" onInput=${(e) => edit({ address: e.target.value })} /></label>
    </div>
    <label class="am-field"><span>A note on the invite</span><textarea rows="2" maxlength="1000" value=${m.inviteNote} placeholder="Parking, which door, a gate code" onInput=${(e) => edit({ inviteNote: e.target.value })}></textarea></label>
  </section>`;
}

// ─── The agenda ─────────────────────────────────────────────────────

/** A name that wraps to as many lines as it needs, on a phone above all. Enter doesn't add a line */
function Line({ value, onInput, ...rest }) {
  const ref = useRef(null);
  const fit = () => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; };
  useEffect(fit, [value]);
  useEffect(() => { addEventListener('resize', fit); return () => removeEventListener('resize', fit); }, []);
  return html`<textarea ref=${ref} class="am-line" rows="1" value=${value} onInput=${onInput} onKeyDown=${(e) => { if (e.key === 'Enter') e.preventDefault(); }} ...${rest}></textarea>`;
}

const blankItem = () => ({ id: uid('i_'), title: '', presenter: '', who: [], notes: '', staffNote: '', report: '', docs: [] });
const swap = (list, i, j) => { const out = [...list]; [out[i], out[j]] = [out[j], out[i]]; return out; };

function Agenda({ m, data, edit, act, onFocus }) {
  const people = useMemo(() => {
    const lead = (data.board || []).find((p) => p.slug === data.settings?.lead);
    return [...(lead ? [lead] : []), ...(data.advisors || []).map((a) => ({ slug: a.slug, name: a.name }))];
  }, [data]);
  const sec = (si, fn) => edit((cur) => ({ ...cur, sections: cur.sections.map((s, i) => (i === si ? fn(s) : s)) }));
  const item = (si, ii, patch) => sec(si, (s) => ({ ...s, items: s.items.map((it, i) => (i === ii ? { ...it, ...patch } : it)) }));
  return html`<section class="am-card" aria-labelledby="am-agenda"><h3 class="am-card__h" id="am-agenda">Agenda</h3>
    ${m.sections.map((s, si) => html`<div class="am-part" key=${s.id}>
      <div class="am-part__top">
        <span class="am-part__n" aria-hidden="true">${si + 1}</span>
        <label class="am-grow"><span class="am-sr">Part ${si + 1}’s name</span><${Line} class="am-line am-part__t" value=${s.title} maxlength="200" placeholder="Name this part" onInput=${(e) => sec(si, (x) => ({ ...x, title: e.target.value.replace(/\n/g, ' ') }))} /></label>
        <label class="am-mins"><span class="am-sr">Minutes for this part</span><input type="number" min="0" max="600" value=${s.minutes || ''} placeholder="min" onInput=${(e) => sec(si, (x) => ({ ...x, minutes: Number(e.target.value) || 0 }))} /></label>
        <span class="am-moves">
          <button type="button" class="am-ic" disabled=${si === 0} aria-label=${`Move part ${si + 1} up`} onClick=${() => edit((cur) => ({ ...cur, sections: swap(cur.sections, si, si - 1) }))}>↑</button>
          <button type="button" class="am-ic" disabled=${si === m.sections.length - 1} aria-label=${`Move part ${si + 1} down`} onClick=${() => edit((cur) => ({ ...cur, sections: swap(cur.sections, si, si + 1) }))}>↓</button>
          <${TwoStep} label="Remove" asked="Remove this part?" empty=${!s.items.some((it) => it.title || it.report)} onYes=${() => edit((cur) => ({ ...cur, sections: cur.sections.filter((_, i) => i !== si) }))} name=${`part ${si + 1}`} />
        </span>
      </div>
      <ul class="am-items">
        ${s.items.map((it, ii) => html`<li class="am-item" key=${it.id} onFocusIn=${() => onFocus(it.id)}>
          <div class="am-item__top">
            <label class="am-grow"><span class="am-sr">Item title</span><${Line} value=${it.title} maxlength="200" placeholder="What’s this item?" onInput=${(e) => item(si, ii, { title: e.target.value.replace(/\n/g, ' ') })} /></label>
            <span class="am-moves">
              <button type="button" class="am-ic" disabled=${ii === 0} aria-label=${`Move “${it.title || 'this item'}” up`} onClick=${() => sec(si, (x) => ({ ...x, items: swap(x.items, ii, ii - 1) }))}>↑</button>
              <button type="button" class="am-ic" disabled=${ii === s.items.length - 1} aria-label=${`Move “${it.title || 'this item'}” down`} onClick=${() => sec(si, (x) => ({ ...x, items: swap(x.items, ii, ii + 1) }))}>↓</button>
              <${TwoStep} label="Remove" asked="Remove this item?" empty=${!it.title && !it.report} onYes=${() => sec(si, (x) => ({ ...x, items: x.items.filter((_, i) => i !== ii) }))} name=${`“${it.title || 'this item'}”`} />
            </span>
          </div>
          <label class="am-field"><span>Who leads it</span>
            <select value=${it.who[0] || ''} onChange=${(e) => item(si, ii, { who: e.target.value ? [e.target.value] : [], presenter: '' })}>
              <option value="">Nobody named</option>
              ${people.map((p) => html`<option value=${p.slug} key=${p.slug}>${p.name}</option>`)}
            </select>
          </label>
          <label class="am-field"><span>What goes on the slide</span><textarea rows="3" value=${it.report} placeholder="A few short points. Each line that starts with a dash is a point." onInput=${(e) => item(si, ii, { report: e.target.value })}></textarea></label>
          <${ItemDocs} m=${m} it=${it} act=${act} />
        </li>`)}
      </ul>
      <button type="button" class="am-link" onClick=${() => sec(si, (x) => ({ ...x, items: [...x.items, blankItem()] }))}>Add an item</button>
    </div>`)}
    <button type="button" class="am-btn" onClick=${() => edit((cur) => ({ ...cur, sections: [...cur.sections, { id: uid('s_'), title: '', minutes: 0, notes: '', items: [blankItem()] }] }))}>Add a part</button>
  </section>`;
}

/** Removing what's been typed asks first; an empty row just goes */
function TwoStep({ label, asked, empty, onYes, name }) {
  const [sure, setSure] = useState(false);
  if (empty) return html`<button type="button" class="am-ic" aria-label=${`${label} ${name}`} onClick=${onYes}>×</button>`;
  if (!sure) return html`<button type="button" class="am-ic" aria-label=${`${label} ${name}`} onClick=${() => setSure(true)}>×</button>`;
  return html`<span class="am-sure" role="group" aria-label=${asked}><span>${asked}</span><button type="button" class="am-link" onClick=${onYes}>Yes</button><button type="button" class="am-link" onClick=${() => setSure(false)}>No</button></span>`;
}

/** Files going up one at a time: which are on their way, and what went wrong, shown right there */
function useUploads(m, act, { itemId = '', kind = '' } = {}) {
  const [uploads, setUploads] = useState([]);
  const [problem, setProblem] = useState('');
  const upload = async (files) => {
    setProblem('');
    setUploads((l) => [...l, ...files.map((f) => f.name)]);
    for (const file of files) {
      const form = new FormData();
      form.set('meetingId', m.id);
      if (itemId) form.set('itemId', itemId);
      if (kind) form.set('kind', kind);
      form.set('file', file);
      await act(null, { form, here: (t) => { if (t) setProblem(t); } });
      setUploads((l) => { const i = l.indexOf(file.name); return i < 0 ? l : [...l.slice(0, i), ...l.slice(i + 1)]; });
    }
  };
  return [uploads, upload, problem, setProblem];
}

function ItemDocs({ m, it, act }) {
  const docs = it.docs.map((id) => m.files.find((f) => f.id === id)).filter(Boolean);
  const free = m.files.filter((f) => f.kind !== RECAP_KIND && !m.sections.some((s) => s.items.some((x) => x.docs.includes(f.id))));
  const [uploads, upload, problem, setProblem] = useUploads(m, act, { itemId: it.id });
  const here = (t) => setProblem(t);
  return html`<div class="am-docs">
    ${docs.map((f) => html`<span class="am-doc" key=${f.id}>${f.name}<button type="button" class="am-ic" aria-label=${`Take ${f.name} off this item`} onClick=${() => act({ action: 'attach-file', id: m.id, fileId: f.id, itemId: '' }, { here })}>×</button></span>`)}
    ${free.map((f) => html`<button type="button" class="am-doc am-doc--free" key=${f.id} onClick=${() => act({ action: 'attach-file', id: m.id, fileId: f.id, itemId: it.id }, { here })}>Add ${f.name}</button>`)}
    ${uploads.map((n, i) => html`<span class="am-doc am-doc--up" role="status" key=${`${n}${i}`}>Uploading ${n}…</span>`)}
    <label class="am-link am-upload">Add a document<input type="file" multiple hidden accept=${FILE_OK} onChange=${(e) => { upload([...e.target.files]); e.target.value = ''; }} /></label>
    ${problem ? html`<p class="am-note am-wide" role="alert">${problem}</p>` : null}
  </div>`;
}

// ─── The presentation beside it ─────────────────────────────────────

/**
 * The presentation as it's written: the advisors' screen page in a frame, told each change before it's saved (as
 * Board's AgendaStage does), with every slide listed and Play from here. Only you see this until it's shared
 */
function Stage({ m, focusId }) {
  const frame = useRef(null);
  const holder = useRef(null);
  const ready = useRef(false);
  const mRef = useRef(m);
  mRef.current = m;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  const [w, setW] = useState(560);
  const [deck, setDeck] = useState(null);
  const src = screenUrl(m.id, 'preview');
  const post = (msg) => frame.current?.contentWindow?.postMessage(msg, location.origin);
  useEffect(() => {
    const el = holder.current;
    if (!el) return undefined;
    const measure = () => setW(el.clientWidth || 560);
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  useEffect(() => {
    const on = (e) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'board-preview-ready') {
        ready.current = true;
        post({ type: 'board-preview', meeting: mRef.current });
        if (focusRef.current) post({ type: 'board-preview-focus', itemId: focusRef.current });
      }
      if (e.data?.type === 'board-preview-deck' && e.data.id === mRef.current.id && Array.isArray(e.data.stops)) setDeck(e.data);
    };
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, []);
  useEffect(() => { if (!ready.current) return undefined; const t = setTimeout(() => post({ type: 'board-preview', meeting: m }), 180); return () => clearTimeout(t); }, [m]);
  useEffect(() => { if (ready.current && focusId) post({ type: 'board-preview-focus', itemId: focusId }); }, [focusId]);
  const stops = deck?.stops || [];
  const at = Math.min(deck?.at || 0, Math.max(0, stops.length - 1));
  const scale = Math.min(1, w / 1280);
  const play = () => window.open(screenUrl(m.id, 'present', stops[at]?.key || ''), `soard-advisory-${m.id}`, 'popup,width=1280,height=760');
  return html`<aside class="am-stage" aria-label="The presentation, as you build the agenda">
    <div class="am-stage__frame" ref=${holder} style=${`height:${Math.round(720 * scale)}px`}>
      <iframe ref=${frame} src=${src} title="The presentation" style=${`width:1280px;height:720px;transform:scale(${scale})`}></iframe>
    </div>
    <div class="am-stage__nav">
      <button type="button" class="am-ic" disabled=${!stops.length || at <= 0} onClick=${() => post({ type: 'board-preview-step', dir: -1 })} aria-label="Back a slide">‹</button>
      <span aria-live="polite">${stops.length ? html`<b>${at + 1}</b> of ${stops.length}` : 'Opening…'}</span>
      <button type="button" class="am-ic" disabled=${!stops.length || at >= stops.length - 1} onClick=${() => post({ type: 'board-preview-step', dir: 1 })} aria-label="Next slide">›</button>
      <button type="button" class="am-btn am-btn--main am-push" disabled=${!stops.length} onClick=${play}>Play from here</button>
    </div>
    <p class="am-muted am-small">${m.shared ? 'As advisors will see it.' : 'Only you see this until it’s shared.'} In its window, the arrow keys or a clicker move it, B blanks the screen, and F fills it.</p>
  </aside>`;
}

// ─── Getting it to advisors ─────────────────────────────────────────

function GettingOut({ m, act, emailsOn }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState('');
  const inv = m.invite;
  const replies = m.replies || [];
  const sendIt = async () => {
    setBusy(true);
    setSaid('');
    const j = await act({ action: 'send-invite', id: m.id }, { here: setProblem });
    setBusy(false);
    if (j?.unchanged) setSaid('Nothing has changed since the invite went out, so nothing was sent.');
    else if (j && inv?.eventId) setSaid(j.quiet ? 'Everyone’s calendar is up to date. Nobody was emailed.' : 'Everyone’s calendar is up to date, and Google emailed them the change.');
  };
  // The day, time or place as they were last sent: a change there is the one thing that emails everyone
  const moved = !!inv?.eventId && (inv.when !== `${m.date} ${m.start || ''}-${m.end || ''}` || ([m.location, m.address].filter(Boolean).join(', ') && [m.location, m.address].filter(Boolean).join(', ') !== inv.place));
  const label = inv?.eventId ? 'Update everyone’s calendar' : m.inviteGone ? 'Send it again' : 'Send invite';
  return html`<section class="am-card" aria-labelledby="am-out"><h3 class="am-card__h" id="am-out">Getting it to advisors</h3>
    <div class="am-out">
      <div>
        <p class="am-strong">${inv?.eventId ? `Invite sent ${shortDate(new Date(inv.sentAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }))}` : m.inviteGone ? 'The invite was deleted in Google Calendar' : 'No invite yet'}</p>
        <p class="am-muted">${inv?.eventId
          ? `${inv.guests} ${inv.guests === 1 ? 'person' : 'people'} on it, with Google Meet. Guests can’t see each other. A new day, time or place follows by itself.`
          : `It goes to every advisor with an email on file, whoever runs the group, and the admins, with Google Meet. Guests can’t see each other.${emailsOn ? ' Nothing goes out until you press the button.' : ''}`}</p>
        ${inv?.differs ? html`<p class="am-note">The invite was changed in Google Calendar and put back once. It’s been changed again, so it’s been left alone. Update the invite to put this meeting’s details back.</p>` : null}
        ${!emailsOn ? html`<p class="am-muted">Emails to advisors are off, so ${inv?.eventId ? 'changes to the invite wait' : 'the invite waits'} until they’re on under Members. Everything else here works the same.</p>`
          : m.canInvite === false ? html`<p class="am-note">Google Calendar isn’t connected yet, so an invite can’t go out. Peter or Holly can connect it.</p>`
            : html`<button type="button" class="am-btn" disabled=${busy || timesWrong(m)} onClick=${sendIt}>${busy ? 'Sending…' : label}</button>
              ${inv?.eventId ? html`<p class="am-muted am-small">${moved ? 'The day, time or place changed, so Google will email everyone.' : 'Only a change of day, time or place emails them.'}</p>` : null}
              ${said ? html`<p class="am-note" role="status">${said}</p>` : null}`}
        ${problem ? html`<p class="am-note" role="alert">${problem}</p>` : null}
      </div>
      <div>
        <label class="am-switch"><input type="checkbox" checked=${m.shared} onChange=${(e) => act({ action: 'share-meeting', id: m.id, shared: e.target.checked }, { here: setProblem })} /><span class="am-strong">On the advisors’ page</span></label>
        <p class="am-muted">${m.shared ? 'Advisors can see this meeting, its agenda and its documents.' : 'Advisors don’t see this meeting yet.'}</p>
      </div>
    </div>
    ${replies.length ? html`<h4 class="am-h4">Who’s coming</h4><ul class="am-replies">${replies.map((r) => html`<li key=${r.slug}><span>${r.name}</span><span class="am-muted">${ANSWERS[r.answer] || ''}</span></li>`)}</ul>` : null}
  </section>`;
}

function Recap({ m, edit, act, held }) {
  const files = m.files.filter((f) => f.kind === RECAP_KIND);
  const [uploads, upload, problem, setProblem] = useUploads(m, act, { kind: RECAP_KIND });
  const here = (t) => setProblem(t);
  const vf = viewerFiles(files);
  // Nothing to show: it isn't on the page, whatever it was a moment ago, and the switch is free to use once there is
  const empty = !m.recap.trim() && !files.some((f) => !f.staffOnly);
  return html`<section class="am-card" aria-labelledby="am-recap"><h3 class="am-card__h" id="am-recap">Recap</h3>
    <p class="am-muted">${held ? 'A few lines for anyone who missed it, and any photos or slides.' : 'After the meeting: a few lines for anyone who missed it, and any photos or slides.'}</p>
    <label class="am-field"><span class="am-sr">The recap</span><textarea rows="4" maxlength="6000" value=${m.recap} placeholder="What happened, and what’s next" onInput=${(e) => edit({ recap: e.target.value })}></textarea></label>
    <div class="am-docs">
      ${files.map((f, i) => html`<span class="am-doc" key=${f.id}><a ...${viewerLink(vf, i)}>${f.name}</a><button type="button" class="am-ic" aria-label=${`Delete ${f.name}`} onClick=${() => act({ action: 'delete-meeting-file', fileId: f.id }, { here })}>×</button></span>`)}
      ${uploads.map((n, i) => html`<span class="am-doc am-doc--up" role="status" key=${`${n}${i}`}>Uploading ${n}…</span>`)}
      <label class="am-link am-upload">Add a file<input type="file" multiple hidden accept=${FILE_OK} onChange=${(e) => { upload([...e.target.files]); e.target.value = ''; }} /></label>
      ${problem ? html`<p class="am-note am-wide" role="alert">${problem}</p>` : null}
    </div>
    <label class="am-switch"><input type="checkbox" checked=${m.recapShared && !empty} disabled=${empty} onChange=${(e) => act({ action: 'share-recap', id: m.id, shared: e.target.checked }, { here })} /><span class="am-strong">On the advisors’ page</span></label>
    ${empty ? html`<p class="am-muted am-small">Write something or add a file, and it can go on the page.</p>` : null}
  </section>`;
}

function Files({ m, act }) {
  const files = m.files.filter((f) => f.kind !== RECAP_KIND);
  const [problem, setProblem] = useState('');
  if (!files.length) return null;
  const here = (t) => setProblem(t);
  const vf = viewerFiles(files);
  return html`<section class="am-card" aria-labelledby="am-files"><h3 class="am-card__h" id="am-files">Documents</h3>
    <ul class="am-files">${files.map((f, i) => html`<li key=${f.id}>
      <a ...${viewerLink(vf, i)}>${f.name}</a><span class="am-muted">${sizeText(f.size)}</span>
      <label class="am-switch am-switch--small"><input type="checkbox" checked=${!f.staffOnly} onChange=${(e) => act({ action: 'update-meeting-file', fileId: f.id, staffOnly: !e.target.checked }, { here })} /><span>Advisors see it</span></label>
      <${TwoStep} label="Delete" asked="Delete this file?" empty=${false} onYes=${() => act({ action: 'delete-meeting-file', fileId: f.id }, { here })} name=${f.name} />
    </li>`)}</ul>
    ${problem ? html`<p class="am-note" role="alert">${problem}</p>` : null}
  </section>`;
}

function Remove({ m, held, onRemove }) {
  const [sure, setSure] = useState(false);
  const [problem, setProblem] = useState('');
  const out = !held && m.invite?.eventId;
  if (!sure) return html`<div class="am-end"><button type="button" class="am-link" onClick=${() => setSure(true)}>Delete this meeting</button></div>`;
  return html`<div class="am-end" role="group" aria-label="Delete this meeting?">
    <p>${out ? 'Delete it? Everyone on the invite gets a cancellation from Google.' : 'Delete it, with its agenda and files?'}</p>
    <button type="button" class="am-btn" onClick=${() => onRemove(setProblem)}>Delete it</button> <button type="button" class="am-link" onClick=${() => setSure(false)}>Keep it</button>
    ${problem ? html`<p class="am-note am-wide" role="alert">${problem}</p>` : null}
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// Styles: its own, so it reads the same in the staff admin and on the advisors' page
// ═══════════════════════════════════════════════════════════════════

let added = false;
function addStyles() {
  if (added || document.getElementById('am-styles')) { added = true; return; }
  added = true;
  const el = document.createElement('style');
  el.id = 'am-styles';
  el.textContent = `
.am{--am-ink:#2D2E33;--am-soft:#5A5B61;--am-line:#E5E4E0;--am-card:#fff;--am-warm:#F5F4F0;--am-sun:#FFDA24;--am-dark:#373A36;color:var(--am-ink);font-family:Outfit,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;display:grid;gap:14px;min-width:0}
.am *{box-sizing:border-box}
.am input,.am textarea,.am select{font:inherit;color:inherit;width:100%;padding:8px 10px;border:1px solid #CFCDC6;border-radius:8px;background:#fff;min-width:0}
.am input[type=checkbox]{width:auto;accent-color:var(--am-dark)}
.am textarea{resize:vertical}
.am input:focus-visible,.am textarea:focus-visible,.am select:focus-visible,.am button:focus-visible,.am a:focus-visible,.am .am-upload:focus-within{outline:2px solid var(--am-dark);outline-offset:1px}
.am-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.am-card{background:var(--am-card);border:1px solid var(--am-line);border-radius:12px;padding:16px;display:grid;gap:12px;min-width:0}
.am-card__h{font-size:16px;font-weight:700;margin:0}
.am-h{font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--am-soft);margin:6px 0 0}
.am-h4{font-size:14px;font-weight:700;margin:0}
.am-muted{color:var(--am-soft);margin:0}
.am-small{font-size:13px}
.am-strong{font-weight:600;margin:0}
.am-note{margin:0;background:var(--am-warm);border-radius:8px;padding:8px 12px}
.am-field{display:grid;gap:4px;min-width:0}
.am-field>span{font-size:13px;font-weight:600;color:var(--am-soft)}
.am-grow{flex:1;min-width:0}
.am-add{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px}
.am-add .am-field{max-width:220px}
.am-add .am-note{flex-basis:100%}
.am-btn{font:inherit;font-weight:600;padding:8px 14px;border-radius:8px;border:1px solid var(--am-dark);background:#fff;color:var(--am-dark);cursor:pointer;justify-self:start}
.am-btn--main{background:var(--am-sun);border-color:var(--am-sun);color:#2D2E33}
.am-btn:disabled{opacity:.55;cursor:default}
.am-link{font:inherit;background:none;border:0;padding:0;color:var(--am-dark);text-decoration:underline;text-underline-offset:2px;cursor:pointer;justify-self:start}
.am-ic{font:inherit;width:30px;height:30px;display:inline-grid;place-items:center;border:1px solid var(--am-line);border-radius:7px;background:#fff;color:var(--am-dark);cursor:pointer;padding:0;flex:none}
.am-ic:disabled{opacity:.35;cursor:default}
.am-push{margin-left:auto}
.am-empty{text-align:center;padding:28px 18px}
.am-empty__t{font-weight:700;margin:0}
.am-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.am-row{font:inherit;color:inherit;width:100%;text-align:left;display:flex;align-items:center;gap:12px;background:#fff;border:1px solid var(--am-line);border-radius:12px;padding:10px 12px;cursor:pointer;flex-wrap:wrap}
.am-row:hover{border-color:var(--am-dark)}
.am-tile{width:52px;height:52px;flex:none;border-radius:10px;background:var(--am-sun);display:grid;place-items:center;align-content:center;font-size:20px;font-weight:700;line-height:1.05}
.am-tile b{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.am-row__t{display:grid;flex:1;min-width:190px}
.am-row__s{font-size:13px;color:var(--am-soft)}
.am-top{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
.am-saved{font-size:13px;color:var(--am-soft)}
.am-saved.is-failed{color:var(--am-ink);font-weight:600}
.am-name input{font-size:22px;font-weight:700;border-color:transparent;padding:4px 6px;margin-left:-6px;background:transparent}
.am-name input:hover{border-color:var(--am-line)}
.am-steps{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.am-steps li{font-size:13px;padding:3px 10px;border-radius:999px;background:var(--am-warm);color:var(--am-soft)}
.am-steps li.is-done{background:var(--am-dark);color:#fff}
.am-steps li.is-next{background:var(--am-sun);color:#2D2E33;font-weight:600}
.am-split{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}
@media (min-width:1180px){.am-split{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.am-stage{position:sticky;top:12px}}
.am-col{display:grid;gap:14px;min-width:0}
.am-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.am-grid--two{grid-template-columns:repeat(2,minmax(0,1fr))}
@media (max-width:520px){.am-grid,.am-grid--two{grid-template-columns:minmax(0,1fr)}}
.am-part{display:grid;gap:8px;padding-bottom:12px;border-bottom:1px solid var(--am-line)}
.am-part__top,.am-item__top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.am-part__n{width:24px;height:24px;flex:none;border-radius:999px;background:var(--am-dark);color:#fff;font-size:13px;font-weight:700;display:grid;place-items:center}
.am-part__top .am-part__t{font-weight:600}
.am-mins{width:74px;flex:none}
.am-moves{display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap}
.am .am-line{resize:none;overflow:hidden;display:block;line-height:1.35}
.am-stay{display:grid;gap:6px}
.am-stay p{margin:0}
.am-stay__do{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
@media (max-width:520px){.am-part__top .am-grow,.am-item__top .am-grow{flex-basis:100%}}
.am-sure{display:inline-flex;gap:8px;font-size:13px;align-items:center}
.am-items{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.am-item{display:grid;gap:8px;background:var(--am-warm);border-radius:10px;padding:10px;min-width:0}
.am-docs{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.am-doc{font:inherit;font-size:13px;display:inline-flex;gap:6px;align-items:center;background:#fff;border:1px solid var(--am-line);border-radius:7px;padding:3px 6px;max-width:100%;overflow-wrap:anywhere}
.am-doc .am-ic{width:22px;height:22px;border:0}
.am-doc--free{cursor:pointer;border-style:dashed}
.am-doc--up{background:var(--am-warm);border-style:dashed;color:var(--am-soft)}
.am-wide{flex-basis:100%}
.am-upload{font-size:13px}
.am-stage{display:grid;gap:8px;min-width:0}
.am-stage__frame{position:relative;overflow:hidden;background:var(--am-dark);border-radius:10px;width:100%}
.am-stage__frame iframe{border:0;display:block;transform-origin:top left;position:absolute;top:0;left:0}
.am-stage__nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.am-out{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}
.am-out>div{display:grid;gap:6px;align-content:start}
.am-switch{display:inline-flex;gap:8px;align-items:center;cursor:pointer}
.am-switch--small{font-size:13px}
.am-replies{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 16px}
.am-replies li{display:flex;justify-content:space-between;gap:10px}
.am-files{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.am-files li{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.am-files a{overflow-wrap:anywhere;color:inherit}
.am-end{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding-top:4px}
.am-end p{margin:0;flex-basis:100%}
`;
  document.head.append(el);
}
