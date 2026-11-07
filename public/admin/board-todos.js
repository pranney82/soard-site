/**
 * To-dos caught in the minutes
 * ===========================================================================
 * Peter, Nov 6 2026: "yes i want this best in class". The Q4 2026 notes held
 * five to-dos as plain lines ("Scott to confirm by end of November") and not one
 * action item, so nothing tracked them.
 *
 * A line that names someone on the board or staff and what they'll do, or says
 * "Action:" itself, is offered as an action item (./board/notes.js): who, by when
 * if it says, and the secretary's own words. It never rewrites them: the words go
 * on the board's record, so a topic may go in front of the line ("Golf tournament:
 * Scott to confirm…") and nothing else changes. Nothing's added until a person
 * says so. Pure, and no model reads it: the same notes always find the same lines.
 */

import { noteLines } from './board-minutes-template.js';

const DAY = 864e5;
const MAX_TEXT = 1000;
const MONTH = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAY = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday';
const BY = '(?:by|before|due(?:\\s+by)?)';

const squeeze = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const norm = (s) => squeeze(s).toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
const noonOf = (day) => Date.parse(`${day}T12:00:00Z`);
const plusDays = (day, n) => new Date(noonOf(day) + n * DAY).toISOString().slice(0, 10);
const lastOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const monthIndex = (word) => 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(word.slice(0, 3).toLowerCase()) / 3;
/** A real date, or nothing (Feb 31 isn't one) */
function dayOf(y, m, d) {
  if (m < 0 || m > 11 || d < 1 || d > lastOfMonth(y, m)) return '';
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

/**
 * The date a line's words set, counted from the meeting's: "by end of November", "by the end of the year", "by
 * next meeting", "by Dec 3", "by 12/3", "by Friday", "next week". A month or date already past is next year's.
 * Words it can't place → ''.
 */
export function dueIn(words, on, { next = '' } = {}) {
  const text = String(words || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(on || ''))) return '';
  const y = Number(on.slice(0, 4));
  const mo = Number(on.slice(5, 7)) - 1;
  let hit = text.match(new RegExp(`\\b${BY}\\s+(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?(?:(${MONTH})\\b\\.?|(month|year|quarter|week)\\b)`, 'i'));
  if (!hit) { const end = text.match(/\b(year|month|quarter)[-\s]end\b/i); if (end) hit = [end[0], '', end[1]]; }
  if (hit) {
    if (hit[1]) { const m = monthIndex(hit[1]); const yr = m < mo ? y + 1 : y; return dayOf(yr, m, lastOfMonth(yr, m)); }
    const unit = hit[2].toLowerCase();
    if (unit === 'month') return dayOf(y, mo, lastOfMonth(y, mo));
    if (unit === 'year') return dayOf(y, 11, 31);
    if (unit === 'quarter') { const q = Math.floor(mo / 3) * 3 + 2; return dayOf(y, q, lastOfMonth(y, q)); }
    const wd = new Date(noonOf(on)).getUTCDay();
    return plusDays(on, wd < 5 ? 5 - wd : 12 - wd);
  }
  if (new RegExp(`\\b${BY}\\s+(?:the\\s+|our\\s+)?next\\s+(?:board\\s+)?meeting\\b`, 'i').test(text)) return next || '';
  hit = text.match(new RegExp(`\\b${BY}\\s+(${MONTH})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4})\\b)?`, 'i'));
  if (hit) {
    const m = monthIndex(hit[1]);
    const d = Number(hit[2]);
    if (hit[3]) return dayOf(Number(hit[3]), m, d);
    const same = dayOf(y, m, d);
    return same && same < on ? dayOf(y + 1, m, d) : same;
  }
  hit = text.match(new RegExp(`\\b${BY}\\s+(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?\\b`, 'i'));
  if (hit) {
    const m = Number(hit[1]) - 1;
    const d = Number(hit[2]);
    if (hit[3]) return dayOf(hit[3].length === 2 ? 2000 + Number(hit[3]) : Number(hit[3]), m, d);
    const same = dayOf(y, m, d);
    return same && same < on ? dayOf(y + 1, m, d) : same;
  }
  hit = text.match(new RegExp(`\\b${BY}\\s+(?:next\\s+)?(${WEEKDAY})\\b`, 'i'));
  if (hit) {
    const want = WEEKDAY.split('|').indexOf(hit[1].toLowerCase());
    const gap = (want - new Date(noonOf(on)).getUTCDay() + 7) % 7;
    return plusDays(on, gap || 7);
  }
  return /\bnext\s+week\b/i.test(text) ? plusDays(on, 7) : '';
}

/** The names a line may use for people: each full name, and a first name when one person has it (shared: no owner to give) */
function namesOf(people) {
  const by = new Map();
  const firsts = new Map();
  for (const p of people || []) {
    const name = squeeze(p?.name);
    if (!name) continue;
    by.set(name.toLowerCase(), p);
    const first = name.split(' ')[0].toLowerCase();
    firsts.set(first, firsts.has(first) && firsts.get(first)?.slug !== p.slug ? null : p);
  }
  for (const [first, p] of firsts) if (!by.has(first)) by.set(first, p);
  return by;
}
const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LEADING = '(?:(?:please\\s+)?ask(?:ed)?\\s+|have\\s+|get\\s+)?';
const WILL = '(?:will|to|needs?\\s+to|should|must|has\\s+to|have\\s+to|agreed\\s+to|offered\\s+to|volunteered\\s+to|plans?\\s+to|is\\s+going\\s+to|going\\s+to|is\\s+to)';
const EXPLICIT = /^(?:action(?:\s+items?)?|to[-\s]?dos?|follow[-\s]?ups?|next\s+steps?)\s*[:–—-]\s*(.+)$/i;

/** Who a line gives something to do, or null: { person } (null when it names nobody, an "Action:" line) */
function toDoIn(line, names, nameRe) {
  const said = line.match(EXPLICIT);
  if (nameRe) {
    const body = said ? said[1] : line;
    // (the line whole first: "Dr. Pat Ames to call" has a full stop in a name)
    for (const clause of [body, ...body.split(/\s*;\s*|\s+[-–—]\s+|:\s+|\.\s+/)]) {
      const hit = clause.match(nameRe);
      if (hit) return { person: names.get(squeeze(hit[1]).toLowerCase()) || null };
    }
  }
  if (!said) return null;
  // An "Action:" line that names someone anywhere: theirs
  const named = nameRe ? [...names.keys()].sort((a, b) => b.length - a.length).find((n) => new RegExp(`\\b${escaped(n)}\\b`, 'i').test(said[1])) : '';
  return { person: named ? names.get(named) : null };
}

/**
 * The lines in a meeting's typed notes that read as to-dos and aren't action items yet.
 * `notes`: the draft (`n:<item or part id>`, `a:<row>`, `skipped`: a line's `key`, one to a line). `people`: [{ slug, name }]. `next`: the next
 * meeting's date, for "by next meeting".
 * → [{ key, text, owner, ownerName, due, from, line }] in the agenda's order. `from`: the item or part it was under.
 * `key`: what `skipped` keeps for a line someone said isn't one.
 */
export function findToDos(m, notes = {}, { people = [], next = '' } = {}) {
  const names = namesOf(people);
  const alts = [...names.keys()].sort((a, b) => b.length - a.length).map(escaped).join('|');
  const nameRe = alts ? new RegExp(`^${LEADING}(${alts})(?:\\s*(?:,|and|&)\\s*(?:${alts}))*\\s+${WILL}\\s+(?!be\\b|have\\s+been\\b)\\S`, 'i') : null;
  const skipped = new Set(String(notes.skipped || '').split('\n').filter(Boolean));
  const have = [
    ...(m?.actions || []).map((a) => a.text),
    ...Object.entries(notes).filter(([k]) => k.startsWith('a:')).map(([, v]) => v?.text),
  ].map(norm).filter(Boolean);
  const out = [];
  const seen = new Set();
  const read = (id, title, part) => {
    const typed = notes[`n:${id}`];
    if (typeof typed !== 'string' || !typed.trim()) return;
    const groups = typed.split(/\n\s*\n/).map((g) => noteLines(g)).filter((g) => g.length);
    for (const group of groups) {
      group.forEach((raw, i) => {
        const line = squeeze(raw);
        const hit = toDoIn(line, names, nameRe);
        if (!hit) return;
        const key = `${id}:${norm(line)}`.slice(0, 120).trim();
        if (skipped.has(key) || seen.has(key)) return;
        // Which of several topics in the notes it's about: its own words before a colon, the line that heads its
        // lines, else the item (the line alone says too little to read later: "Scott to confirm by end of November")
        const own = /^[^:]{3,80}:\s/.test(line) && !EXPLICIT.test(line);
        const heads = groups.length > 1 || part;
        const topic = own ? '' : squeeze(heads ? (i > 0 ? group[0] : '') : title).replace(/[\s:;,.-]+$/, '');
        const text = (topic && !norm(line).startsWith(norm(topic)) ? `${topic}: ${line}` : line).slice(0, MAX_TEXT);
        if (have.some((h) => h === norm(text) || h === norm(line) || h.includes(norm(line)))) return;
        seen.add(key);
        out.push({ key, text, owner: hit.person?.slug || '', ownerName: hit.person?.name || '', due: dueIn(line, m?.date, { next }), from: id, line });
      });
    }
  };
  for (const s of m?.sections || []) {
    for (const it of s.items || []) read(it.id, it.title || s.title || '', false);
    read(s.id, s.title || '', true);
  }
  return out;
}
