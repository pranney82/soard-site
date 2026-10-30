/**
 * Board meetings' minutes, read into the meeting
 * ===========================================================================
 * Peter, Oct 2026: "i am not the secretary. i will upload meeting minutes with
 * all that information for you to do the attendance and fill in the minutes."
 * So a minutes file (PDF or Word) fills the meeting by itself, with nothing to
 * look over first:
 *   - who was there: the attendee table's x marks, or "Present: …",
 *     "Absent – …" lines (parseAgendaText, attendanceIn), else Workers AI
 *   - each agenda item's notes: the minutes' numbered outline
 *     (parseAgendaText), else Workers AI's reading of what each part said
 *   - the motions (who moved and seconded, passed, failed or tabled) and the
 *     action items (whose, by when): Workers AI, else the usual wording
 *     ("Motion to approve … by Alex, seconded by Sam. Motion passed.")
 *   - whether the board approved the last meeting's minutes
 * readMinutes reads; applyMinutes (pure) puts what was read onto a meeting:
 * the minutes are the record of who was there, the agenda keeps its items and
 * their documents, each taking its notes from the minutes. readMinutesInto is
 * the admin's upload (POST /api/board-admin read-minutes). Board's Google Drive
 * and email readers (./_board-drive.js, ./_board-mail.js) use the same two for
 * minutes that come in by themselves, leaving attendance a person marked as it is.
 * Without Workers AI (or when it fails) the rules alone read them; never throws.
 */

import { fileText, attendanceIn } from './_board-mail.js';
import { getMeeting, patchMeeting, listMeetings, roster, boardFiles, updateFile, approveMinutes } from './_board.js';
import { readState, writeState } from './_board-roles.js';
import { parseAgendaText, agendaIsDraft, meetingName, shortDate, isDate, uid } from '../../public/admin/board-shared.js';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// How long the model may take. Read by hand (the person is waiting, Cloudflare allows 100 seconds): up to 70 seconds
// in all, most of it for the first try. On the heartbeat (`quick`): one try that fits its 30 seconds; minutes it
// didn't finish are read again later by maybeFinishMinutes
const AI_BUDGET_MS = 70000;
const AI_TRY_MS = 55000;
const QUICK_TIMEOUT_MS = 24000;
const MAX_TEXT = 24000; // characters of the minutes the model reads (about 6,000 tokens)

const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const one = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const STATUSES = ['present', 'remote', 'absent', 'excused'];
const RESULTS = ['passed', 'failed', 'tabled'];

// ─── People ─────────────────────────────────────────────────────────

/** The board and staff as minutes name them: [{ slug, name, org, kind }] (the way readFileAsAgenda builds it) */
export async function minutesPeople(DB) {
  const r = await roster(DB);
  return [
    ...r.board.map((p) => ({ slug: p.slug, name: p.name, org: p.organization || '', kind: 'board' })),
    ...r.staff.map((p) => ({ slug: p.slug, name: p.name, org: 'SOARD', kind: 'staff' })),
  ];
}

/**
 * A name as minutes write it ("Alex", "Alex R.", "Alex Rivera (Rivera Builders)", "Ms. Rivera") → the person, or null.
 * Full name first; then a first name with the last name's initial; then a first or last name only one person has.
 */
export function matchPerson(name, people = []) {
  const p0 = plain(String(name || '').replace(/\([^)]*\)/g, ' ').replace(/\b(mr|mrs|ms|miss|dr)\b\.?/gi, ' '));
  if (!p0) return null;
  const list = people.map((p) => ({ p, full: plain(p.name) })).filter((x) => x.full);
  const exact = list.find((x) => x.full === p0) || list.find((x) => p0.startsWith(`${x.full} `)) || list.find((x) => ` ${p0} `.includes(` ${x.full} `));
  if (exact) return exact.p;
  const words = p0.split(' ');
  const firstOf = (x) => x.full.split(' ')[0];
  const lastOf = (x) => x.full.split(' ').at(-1);
  if (words.length === 2 && words[1].length === 1) {
    const hit = list.filter((x) => firstOf(x) === words[0] && lastOf(x).startsWith(words[1]));
    if (hit.length === 1) return hit[0].p;
  }
  if (words.length === 1) {
    const byFirst = list.filter((x) => firstOf(x) === words[0]);
    if (byFirst.length === 1) return byFirst[0].p;
    const byLast = list.filter((x) => x.full.includes(' ') && lastOf(x) === words[0]);
    if (byLast.length === 1) return byLast[0].p;
  }
  return null;
}
/** A matched person's full name, or the name as written */
const nameOf = (name, people) => matchPerson(name, people)?.name || one(name, 120);

/** The model's attendance as the meeting keeps it: the board and staff by their slug, anyone else present as a guest */
function attendanceFrom(list, people) {
  const out = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    const status = STATUSES.includes(a?.status) ? a.status : '';
    const name = one(a?.name, 120);
    if (!status || !name) continue;
    const p = matchPerson(name, people);
    if (p) {
      if (!out.has(p.slug)) out.set(p.slug, { slug: p.slug, name: p.name, org: p.org || '', kind: p.kind === 'staff' ? 'staff' : 'board', status });
    } else if (status === 'present' || status === 'remote') {
      const key = `guest:${name.toLowerCase()}`;
      if (!out.has(key)) out.set(key, { name, org: '', kind: 'guest', status });
    }
  }
  return [...out.values()];
}

// ─── The usual wording, without Workers AI ──────────────────────────

const NAME = "([A-Z][\\w'’.-]*(?:\\s+[A-Z][\\w'’-]*)?)";
const MOTION_TO = new RegExp(`\\b[Mm]otion\\s+(?:was\\s+)?(?:made\\s+)?(?:by\\s+${NAME}\\s+)?to\\s+(.+?)(?:,?\\s+(?:made\\s+)?by\\s+${NAME})?(?:[,;]?\\s+(?:and\\s+)?(?:was\\s+)?second(?:ed)?(?:\\s+by\\s+${NAME})?)?\\s*[.;]?\\s*$`);
const MOVED = new RegExp(`\\b${NAME}\\s+(?:made\\s+a\\s+motion|moved)\\s+(?:to\\s+)?(.+?)(?:[,;]?\\s+(?:and\\s+)?${NAME}\\s+seconded(?:\\s+it|\\s+the\\s+motion)?|[,;]?\\s+(?:and\\s+)?(?:it\\s+was\\s+)?second(?:ed)?\\s+by\\s+${NAME})?\\s*[.;]?\\s*$`);
const resultIn = (s) => (/\b(failed|did not pass|defeated|was not approved)\b/i.test(s) ? 'failed'
  : /\btabled\b/i.test(s) ? 'tabled'
  : /\b(passed|carried|approved|unanimous(ly)?|all in favor|so moved)\b/i.test(s) ? 'passed' : '');
const cleanMotion = (s) => {
  const t = one(s, 1000).replace(/\s+(?:and\s+)?(?:it\s+)?was\s+second(?:ed)?$/i, '')
    .replace(/(?:[,;]|\s)\s*(?:and\s+)?(?:the\s+motion\s+)?(?:was\s+)?(?:passed|carried|failed|tabled)(?:\s+unanimously)?$/i, '')
    .replace(/[\s.,;:]+$/, '');
  return t ? t[0].toUpperCase() + t.slice(1) : '';
};
// Capitalized words that open a sentence but aren't anyone ("The board moved to …")
const NOT_A_NAME = /^(the|a|an|it|this|that|board|motion|meeting|everyone|all|members?|chair|someone)\b/i;
const MENTIONS_MOTION = /\b(motion|moved)\b/i;

/** The motions minutes write the usual ways, each with its result from the same sentence or the ones after it → [{ text, by, second, result }] */
export function motionsIn(text, people = []) {
  const sentences = String(text || '').replace(/\r\n?/g, '\n').split(/\n+|(?<=[.!?])\s+(?=[A-Z])/).map((s) => s.trim().replace(/^[-•*\d.)\s]+(?=[A-Za-z])/, '')).filter(Boolean);
  const who = (s) => { const t = one(s, 120); return !t || NOT_A_NAME.test(t) ? '' : nameOf(t, people); };
  const out = [];
  sentences.forEach((s, i) => {
    let m = s.match(MOTION_TO);
    let motion = null;
    if (m) motion = { text: m[2], by: m[1] || m[3] || '', second: m[4] || '' };
    else if ((m = s.match(MOVED))) motion = { text: m[2], by: m[1], second: m[3] || m[4] || '' };
    if (!motion) return;
    const said = cleanMotion(motion.text);
    if (!said || said.length < 6) return;
    // Its result: in its own sentence ("… carried unanimously"), else the next two, up to the next motion
    const after = [];
    for (const x of sentences.slice(i + 1, i + 3)) { if (MENTIONS_MOTION.test(x) && !/^(the\s+)?motion\s+(passed|carried|failed|was)/i.test(x)) break; after.push(x); }
    const result = resultIn(motion.text) || resultIn(after.join(' ')) || 'passed';
    out.push({ text: said, by: who(motion.by), second: who(motion.second), result });
  });
  return dedupe(out, (x) => x.text);
}

/** The last meeting's minutes approved: a passed motion to approve minutes, or "approved" under the minutes part of the outline */
export function approvalIn(sections = [], motions = []) {
  if (motions.some((x) => x.result === 'passed' && /\bminutes\b/i.test(x.text) && /\bapprov/i.test(x.text))) return true;
  return sections.some((s) => (/minutes/i.test(s.title) ? s.items : s.items.filter((it) => /minutes/i.test(it.title)))
    .some((it) => /\bapproved\b/i.test(`${it.title}\n${it.notes || ''}`) && !/\bnot\s+(been\s+)?approved\b|\btabled\b/i.test(`${it.title}\n${it.notes || ''}`)));
}

// ─── Workers AI ─────────────────────────────────────────────────────

const PROMPT = `You read the minutes of a board meeting of SOARD (Sunshine on a Ranney Day), a nonprofit, and write down only what the minutes say. Never guess, add or improve anything.
- attendance: each person the minutes say was present, on video or phone ("remote"), absent, or excused. [] when the minutes don't say who attended.
- motions: each motion the board voted on. "text" is what was moved as a short sentence starting with a verb ("Approve the 2027 budget"). "by" and "second" are the names as written ("" when not said). "result": "passed" when the minutes say passed, carried, approved or unanimous; "failed"; or "tabled".
- actions: each follow-up someone agreed to do after the meeting. "text" is the task as a short sentence, "owner" the person's name as written ("" when nobody is named), "due" the date it's due as YYYY-MM-DD ("" when no date is given).
- approvedPrev: true only when the minutes say the board approved the minutes of the previous meeting.`;
const TOPICS_PROMPT = `
- topics: the minutes' parts in order: "section" (the heading it's under, "" if none), "title" (the agenda item, using the agenda's wording when the minutes cover one of its items) and "points" (what was said, each a short sentence, in the minutes' own words).`;
const PERSON = { type: 'object', properties: { name: { type: 'string' }, status: { type: 'string', enum: STATUSES } }, required: ['name', 'status'] };
const MOTION = { type: 'object', properties: { text: { type: 'string' }, by: { type: 'string' }, second: { type: 'string' }, result: { type: 'string', enum: RESULTS } }, required: ['text', 'by', 'second', 'result'] };
const ACTION = { type: 'object', properties: { text: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string' } }, required: ['text', 'owner', 'due'] };
const TOPIC = { type: 'object', properties: { section: { type: 'string' }, title: { type: 'string' }, points: { type: 'array', items: { type: 'string' } } }, required: ['section', 'title', 'points'] };
const schemaFor = (topics, attendance = true) => ({
  type: 'object',
  properties: {
    ...(attendance ? { attendance: { type: 'array', items: PERSON } } : {}), motions: { type: 'array', items: MOTION }, actions: { type: 'array', items: ACTION }, approvedPrev: { type: 'boolean' },
    ...(topics ? { topics: { type: 'array', items: TOPIC } } : {}),
  },
  required: [...(attendance ? ['attendance'] : []), 'motions', 'actions', 'approvedPrev', ...(topics ? ['topics'] : [])],
});

function withTimeout(p, ms) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}
/** The model's answer as an object, whichever shape it came back in */
function answerOf(out) {
  const r = out?.response ?? out?.choices?.[0]?.message?.content ?? out;
  if (r && typeof r === 'object' && !Array.isArray(r)) return r;
  const m = String(r || '').match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

const KEY_LINE = /\b(motion|moved|second(ed)?|vote[ds]?|approv\w*|action items?|follow[- ]?up|will\s+(send|reach|follow|contact|schedule|draft|prepare|share|look)|to do|task|due|deadline|present|absent|excused|attend\w*)\b/i;
/** Minutes too long for the model: the start (who was there, the first business), then every line about a motion, a vote, a task or attendance */
export function excerpt(text, max = MAX_TEXT) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max / 4));
  const lines = s.slice(head.length).split('\n');
  const keep = [];
  let size = head.length;
  for (let i = 0; i < lines.length && size < max; i++) {
    if (!KEY_LINE.test(lines[i])) continue;
    const chunk = lines.slice(Math.max(0, i - 1), i + 2).join('\n').trim();
    keep.push(chunk);
    size += chunk.length + 1;
    i += 1;
  }
  return `${head}\n…\n${keep.join('\n')}`.slice(0, max);
}

/** Workers AI's reading of the minutes, or null (no model, no answer in time, nothing usable) */
async function askMinutes(env, { text, meeting, prev, people, topics, quick, attendance = true }) {
  if (!env?.AI?.run) return null;
  const agenda = (meeting?.sections || []).flatMap((s) => s.items.map((it) => `${s.title ? `${s.title}: ` : ''}${it.title}`)).filter(Boolean);
  const input = [
    meeting?.date ? `This meeting: the ${meetingName(meeting)} on ${shortDate(meeting.date)}.` : '',
    prev?.date ? `The previous meeting: the ${meetingName(prev)} on ${shortDate(prev.date)}.` : '',
    people.length ? `SOARD's board and staff: ${people.map((p) => p.name).join(', ')}.` : '',
    topics && agenda.length ? `The agenda's items:\n${agenda.slice(0, 60).join('\n')}` : '',
    `The minutes:\n\n${excerpt(text)}`,
  ].filter(Boolean).join('\n\n');
  // Attendance the outline already has isn't asked for again: a shorter answer comes back sooner
  const prompt = attendance ? PROMPT : PROMPT.replace(/^- attendance:.*\n/m, '');
  const messages = [{ role: 'system', content: `${prompt}${topics ? TOPICS_PROMPT : ''}\nAnswer with JSON only.` }, { role: 'user', content: input }];
  const until = Date.now() + (quick ? QUICK_TIMEOUT_MS : AI_BUDGET_MS);
  for (const json of quick ? [true] : [true, false]) {
    const ms = Math.min(quick ? QUICK_TIMEOUT_MS : AI_TRY_MS, until - Date.now());
    if (ms < 5000) break;
    try {
      const out = await withTimeout(env.AI.run(MODEL, {
        messages, max_tokens: topics ? 3000 : attendance ? 1500 : 1000, temperature: 0,
        ...(json ? { response_format: { type: 'json_schema', json_schema: schemaFor(topics, attendance) } } : {}),
      }), ms);
      const a = answerOf(out);
      if (a && (Array.isArray(a.motions) || Array.isArray(a.attendance) || Array.isArray(a.actions) || Array.isArray(a.topics))) return a;
    } catch (err) {
      console.error('[board-minutes]', err.message);
      // Out of time: another try won't fit what's left
      if (err.message === 'timeout') break;
    }
  }
  return null;
}

/** The model's parts of the minutes as sections and items with notes (each point a "- " line) */
function sectionsFrom(topics) {
  const out = [];
  for (const t of Array.isArray(topics) ? topics : []) {
    const title = one(t?.title, 200);
    const points = (Array.isArray(t?.points) ? t.points : []).map((p) => one(p, 1000)).filter(Boolean);
    if (!title && !points.length) continue;
    const head = one(t?.section, 200);
    let s = out.at(-1);
    if (!s || s.title !== head) { s = { id: uid('s_'), title: head, items: [] }; out.push(s); }
    s.items.push({ id: uid('i_'), title: title || head || 'Discussion', presenter: '', notes: points.map((p) => `- ${p}`).join('\n'), staffNote: '', confidential: false, live: '' });
  }
  return out;
}

// ─── Reading ────────────────────────────────────────────────────────

/**
 * What a minutes file says. `bytes` (read with fileText) or `text` when it's read already; `meeting` and `prev` (the
 * meeting before) tell the model which meeting it is and its agenda; `people` as minutesPeople builds them. `quick`
 * (Board's own readers, on the heartbeat): one try of the model, sooner given up on.
 * → { attendance, sections, motions, actions, approvedPrev, said: { by: 'ai' | 'rules', chars, date, start, end, location } }
 */
export async function readMinutes(env, { name = '', bytes = null, text = null, meeting = null, people = [], prev = null, quick = false } = {}) {
  const words = text != null ? String(text) : bytes ? await fileText(env, { name, bytes }) : '';
  if (!words.trim()) return { attendance: [], sections: [], motions: [], actions: [], approvedPrev: false, said: { by: 'rules', chars: 0, date: '', start: '', end: '', location: '' } };
  const parsed = parseAgendaText(words, people);
  let attendance = parsed.attendance.length ? parsed.attendance : attendanceIn(words, people);
  let sections = parsed.sections;
  let motions = motionsIn(words, people);
  let actions = [];
  let approvedPrev = false;
  let by = 'rules';
  // The outline read by the rules is kept as it is; the model fills in the outline only when the rules found none
  const topics = !sections.some((s) => s.items.length);
  const ai = await askMinutes(env, { text: words, meeting, prev, people, topics, quick, attendance: !attendance.length });
  if (ai) {
    by = 'ai';
    if (!attendance.length) attendance = attendanceFrom(ai.attendance, people);
    const said = (Array.isArray(ai.motions) ? ai.motions : []).map((x) => ({
      text: cleanMotion(x?.text), by: x?.by ? nameOf(x.by, people) : '', second: x?.second ? nameOf(x.second, people) : '', result: RESULTS.includes(x?.result) ? x.result : 'passed',
    })).filter((x) => x.text);
    if (said.length) motions = dedupe(said, (x) => x.text);
    actions = dedupe((Array.isArray(ai.actions) ? ai.actions : []).map((x) => {
      const p = x?.owner ? matchPerson(x.owner, people) : null;
      return { text: one(x?.text, 1000), owner: p?.slug || '', ownerName: p?.name || one(x?.owner, 120), due: isDate(String(x?.due || '')) ? x.due : '' };
    }).filter((x) => x.text), (x) => x.text);
    if (topics) sections = sectionsFrom(ai.topics);
    approvedPrev = ai.approvedPrev === true;
  }
  approvedPrev = approvedPrev || approvalIn(sections, motions);
  return { attendance, sections, motions, actions, approvedPrev, said: { by, chars: words.length, date: parsed.date || '', start: parsed.start || '', end: parsed.end || '', location: parsed.location || '' } };
}
/** Whether a reading found anything to put on a meeting */
export const readSomething = (read) => !!read && (read.attendance.length > 0 || read.sections.some((s) => s.items.length) || read.motions.length > 0 || read.actions.length > 0);

// ─── Putting it on the meeting ──────────────────────────────────────

const STOP = new Set(['the', 'and', 'of', 'for', 'to', 'a', 'an', 'in', 'on', 'at', 'or', 'by', 'with', 'from', 'our', 'update', 'updates', 'report', 'reports', 'committee', 'meeting', 'board', 'soard', 'item', 'items']);
const stem = (w) => (w.length > 4 ? w.replace(/(ies|es|s)$/, (x) => (x === 'ies' ? 'y' : '')) : w);
const wordsOf = (s) => new Set(plain(String(s || '').replace(/\([^)]*\)/g, ' ')).split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(stem));
/** How alike two titles are: the share of the shorter one's words the other has (0..1) */
export function likeness(a, b) {
  const A = wordsOf(a);
  const B = wordsOf(b);
  // Titles made only of the usual words ("Committee reports") are alike when they're the same
  if (!A.size || !B.size) return plain(a) && plain(a) === plain(b) ? 1 : 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n += 1;
  return n / Math.min(A.size, B.size);
}
function dedupe(list, textOf) {
  const out = [];
  for (const x of list) if (!out.some((y) => likeness(textOf(x), textOf(y)) >= 0.8 && Math.abs(wordsOf(textOf(x)).size - wordsOf(textOf(y)).size) <= 2)) out.push(x);
  return out;
}
const similar = (a, b) => likeness(a, b) >= 0.6;
const hasItems = (m) => (m?.sections || []).some((s) => s.items.length);

/**
 * Whose outline a meeting keeps once minutes are read: 'minutes' (the agenda was empty or a draft nobody wrote, or
 * `whole`: an older reading of this same file) when they have at least `minSections` parts with items, else 'agenda'.
 */
export function shapeFrom(cur, read, { whole = false, minSections = 1 } = {}) {
  const enough = read.sections.filter((s) => s.items.length).length >= minSections;
  return enough && (whole || !hasItems(cur) || agendaIsDraft(cur)) ? 'minutes' : 'agenda';
}

/** Which agenda item each minutes item is: [[agenda {si, ii}, minutes {si, ii}]] by their titles, then their places */
function pairItems(agenda, minutes) {
  const A = agenda.flatMap((s, si) => s.items.map((it, ii) => ({ si, ii, it, sec: s })));
  const M = minutes.flatMap((s, si) => s.items.map((it, ii) => ({ si, ii, it, sec: s })));
  // The parts of the two that are the same (by their headings)
  const secPair = new Map();
  minutes.forEach((s, mi) => {
    const best = agenda.map((a, ai) => [ai, likeness(a.title, s.title)]).sort((x, y) => y[1] - x[1])[0];
    if (best && best[1] >= 0.5) secPair.set(mi, best[0]);
  });
  const minutesy = (x) => /minutes/i.test(`${x.sec.title} ${x.it.title}`);
  const scored = [];
  for (const a of A) {
    for (const m of M) {
      let score = likeness(a.it.title, m.it.title);
      if (a.it.live === 'minutes' && minutesy(m)) score = Math.max(score, 0.9);
      if (score < 0.5) continue;
      if (secPair.get(m.si) === a.si) score += 0.25;
      scored.push([score, a, m]);
    }
  }
  scored.sort((x, y) => y[0] - x[0]);
  const usedA = new Set();
  const usedM = new Set();
  const pairs = [];
  const key = (x) => `${x.si}.${x.ii}`;
  for (const [, a, m] of scored) {
    if (usedA.has(key(a)) || usedM.has(key(m))) continue;
    usedA.add(key(a)); usedM.add(key(m));
    pairs.push([a, m]);
  }
  // In the same place in the same part, when one of the titles says nothing of its own ("Update", "Discussion"):
  // two different titles in the same place are two different things (a deck must never move to another item)
  const generic = (x) => wordsOf(x.it.title).size === 0;
  for (const m of M) {
    if (usedM.has(key(m)) || !secPair.has(m.si)) continue;
    const a = A.find((x) => x.si === secPair.get(m.si) && x.ii === m.ii);
    if (!a || usedA.has(key(a)) || !(generic(a) || generic(m))) continue;
    usedA.add(key(a)); usedM.add(key(m));
    pairs.push([a, m]);
  }
  return { pairs, A, M, secPair, usedA, usedM, key };
}

/** The agenda's own (what the minutes never say): who presents, its documents, live numbers, board-only, private notes */
const carried = (it) => ({ id: it.id, docs: it.docs || [], who: it.who || [], live: it.live || '', about: it.about || '', confidential: !!it.confidential, staffNote: it.staffNote || '' });
const carriesSomething = (it) => (it.docs || []).length > 0 || !!it.staffNote;

function mergeSections(cur, read, shape) {
  const { pairs, A, M, secPair, usedA, usedM, key } = pairItems(cur.sections || [], read.sections);
  const byA = new Map(pairs.map(([a, m]) => [key(a), m]));
  const byM = new Map(pairs.map(([a, m]) => [key(m), a]));
  if (shape === 'minutes') {
    // The minutes' outline; an item that was on the agenda keeps the agenda's id and what only the agenda has
    const out = read.sections.map((s, si) => ({ id: s.id || uid('s_'), title: s.title, items: s.items.map((it, ii) => {
      const a = byM.get(`${si}.${ii}`);
      return a ? { ...it, ...carried(a.it), presenter: a.it.presenter || it.presenter || '' } : it;
    }) }));
    // An agenda item the minutes don't mention is kept only when something hangs off it (its documents, a private note)
    for (const a of A) {
      if (usedA.has(key(a)) || !carriesSomething(a.it)) continue;
      const mi = [...secPair].find(([, ai]) => ai === a.si)?.[0];
      let s = mi !== undefined ? out[mi] : out.find((x) => x.title === a.sec.title);
      if (!s) { s = { id: a.sec.id || uid('s_'), title: a.sec.title, items: [] }; out.push(s); }
      s.items.push(a.it);
    }
    return out;
  }
  // The agenda's outline, every item kept; each takes the minutes' notes for it
  const out = (cur.sections || []).map((s, si) => ({ ...s, items: s.items.map((it, ii) => {
    const m = byA.get(`${si}.${ii}`);
    if (!m) return it;
    return { ...it, notes: String(m.it.notes || '').trim() ? m.it.notes : it.notes, presenter: it.presenter || m.it.presenter || '' };
  }) }));
  // What the minutes cover that the agenda didn't: under the agenda's part with that heading, else a part of its own
  const added = new Map();
  for (const m of M) {
    if (usedM.has(key(m))) continue;
    const ai = secPair.get(m.si);
    if (ai !== undefined) { out[ai].items.push(m.it); continue; }
    if (!added.has(m.si)) { const s = { id: m.sec.id || uid('s_'), title: m.sec.title, items: [] }; added.set(m.si, s); out.push(s); }
    added.get(m.si).items.push(m.it);
  }
  return out;
}

/**
 * The attendance once the minutes are read: they're the record. Each person they name gets what they say;
 * when they name anyone as there, the board members on the list they don't name were absent (an excused one
 * stays excused). Answers to "will you be there" stay. `keepMarked`: attendance someone marked is left as it
 * is (Board's own readers; the minutes then only fill a list nobody marked).
 */
function mergeAttendance(cur, read, { keepMarked }) {
  const list = cur.attendance || [];
  if (!read.attendance.length || (keepMarked && list.some((p) => p.status))) return list;
  const keyOf = (p) => p.slug || `${p.kind || 'guest'}:${String(p.name || '').toLowerCase()}`;
  const had = new Map(list.map((p) => [keyOf(p), p]));
  const out = read.attendance.map((p) => {
    const was = had.get(keyOf(p));
    return { ...(was || {}), ...(p.slug ? { slug: p.slug } : {}), key: keyOf(p), name: was?.name || p.name, org: was?.org || p.org || '', kind: p.kind || was?.kind || 'guest', status: p.status, rsvp: was?.rsvp || '' };
  });
  const named = new Set(out.map(keyOf));
  const anyoneThere = read.attendance.some((p) => p.status === 'present' || p.status === 'remote');
  for (const p of list) {
    if (named.has(keyOf(p))) continue;
    out.push(p.kind === 'board' && anyoneThere ? { ...p, status: p.status === 'excused' ? 'excused' : 'absent' } : p);
  }
  return out;
}

/**
 * The meeting with its minutes read in (pure). `read` is readMinutes' answer. Motions voted on the board page stay,
 * and so does everything else already there; the minutes' motions and action items not already on it are added.
 * The meeting's outline is the agenda's, each item taking its notes from the minutes (or, when the agenda was a
 * draft, the minutes' own outline: see shapeFrom; `agendaFrom` names where it came from then, else it's
 * the person's). `minutesFrom` records the file.
 */
export function applyMinutes(cur, read, { fileName = '', now = Date.now(), keepMarked = false, whole = false, minSections = 1, agendaFrom = null } = {}) {
  const at = new Date(now).toISOString();
  const shape = shapeFrom(cur, read, { whole, minSections });
  const next = { ...cur, attendance: mergeAttendance(cur, read, { keepMarked }) };
  if (read.sections.some((s) => s.items.length)) next.sections = mergeSections(cur, read, shape);
  if (shape === 'minutes') next.agendaFrom = agendaFrom || { kind: 'typed', name: one(fileName, 200), at };
  const motions = [...(cur.motions || [])];
  for (const x of read.motions) if (!motions.some((y) => similar(y.text, x.text))) motions.push({ id: uid('v_'), text: x.text, by: x.by || '', second: x.second || '', result: x.result || 'passed', tally: null });
  next.motions = motions;
  const actions = [...(cur.actions || [])];
  for (const x of read.actions) if (!actions.some((y) => similar(y.text, x.text))) actions.push({ id: uid('a_'), text: x.text, owner: x.owner || '', ownerName: x.ownerName || '', due: x.due || '', done: false, doneOn: '' });
  next.actions = actions;
  // Whether the model read them (the motions and action items); minutes read by the rules alone are read again later
  next.minutesFrom = { name: one(fileName, 200), at, ai: read.said?.by === 'ai', tries: read.said?.by === 'ai' ? 0 : Math.min(9, (cur.minutesFrom?.name === one(fileName, 200) ? cur.minutesFrom.tries || 0 : 0) + 1) };
  return next;
}

/**
 * Whether minutes from this file (`at`: when it was written or sent) may go onto a meeting: no minutes read into
 * it yet, the same file again, or a newer one than the minutes it has (never over ones read in by hand since).
 */
export function minutesNewer(cur, { name = '', at = '' } = {}) {
  const had = cur?.minutesFrom;
  if (!had?.name) return true;
  if (plain(had.name.replace(/\.[a-z0-9]{2,5}$/i, '')) === plain(String(name).replace(/\.[a-z0-9]{2,5}$/i, ''))) return true;
  return !!at && !Number.isNaN(Date.parse(at)) && Date.parse(at) > Date.parse(had.at || 0);
}

/**
 * Minutes the heartbeat read without the model (it ran out of time): read again, one meeting every two minutes and
 * three tries each, so their motions and action items still come in. Nothing a person marked is changed. → id | null
 */
export async function maybeFinishMinutes(env, { now = Date.now() } = {}) {
  try {
    const runs = await readState(env.DB, 'runs');
    if (runs.minutesAt && now - Date.parse(runs.minutesAt) < 2 * 60 * 1000) return null;
    const meetings = await listMeetings(env.DB);
    const m = meetings.filter((x) => x.minutesFrom?.name && !x.minutesFrom.ai && (x.minutesFrom.tries || 0) < 3).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!m) return null;
    await writeState(env.DB, 'runs', { ...runs, minutesAt: new Date(now).toISOString() });
    const f = m.files.find((x) => x.name === m.minutesFrom.name) || m.files.filter((x) => x.kind === 'minutes').at(-1);
    const row = f && await env.DB.prepare('SELECT r2_key FROM board_files WHERE id = ?').bind(f.id).first();
    const obj = row && await boardFiles(env)?.get(row.r2_key);
    const people = await minutesPeople(env.DB);
    const prev = meetings.filter((x) => x.id !== m.id && !x.notBoard && isDate(x.date) && x.date < m.date).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
    const read = obj ? await readMinutes(env, { name: f.name, bytes: new Uint8Array(await new Response(obj.body).arrayBuffer()), meeting: m, people, prev, quick: true }) : null;
    await patchMeeting(env.DB, m.id, (cur) => {
      if (cur.minutesFrom?.name !== m.minutesFrom.name || cur.minutesFrom.ai) return cur;
      if (!read || read.said.by !== 'ai') return { ...cur, minutesFrom: { ...cur.minutesFrom, tries: (cur.minutesFrom.tries || 0) + 1 } };
      // Only what the model adds: the motions and action items (the outline and attendance stay as they were read)
      return applyMinutes(cur, { ...read, attendance: [], sections: [] }, { fileName: cur.minutesFrom.name, now, keepMarked: true });
    });
    return m.id;
  } catch (err) {
    console.error('[board-minutes] finishing', err.message);
    return null;
  }
}

// ─── The admin's upload ─────────────────────────────────────────────

/**
 * One of a meeting's files read as its minutes and put on it (POST /api/board-admin read-minutes): the meeting saved,
 * the file filed as the minutes, and the last meeting's minutes marked approved when these say the board approved
 * them. → { meeting, approvedPrev: id | null, read: { attendance: { here, of }, notes, motions, actions, ai } }
 */
export async function readMinutesInto(env, id, fileId, { by = '', now = Date.now(), dry = false } = {}) {
  const m = await getMeeting(env.DB, id);
  if (!m) throw Object.assign(new Error('That meeting is gone'), { status: 404 });
  const f = m.files.find((x) => x.id === fileId);
  const row = f && await env.DB.prepare('SELECT r2_key FROM board_files WHERE id = ? AND owner_type = ? AND owner_id = ?').bind(fileId, 'meeting', id).first();
  if (!f || !row) throw Object.assign(new Error('That file isn’t on this meeting'), { status: 404 });
  const obj = await boardFiles(env)?.get(row.r2_key);
  if (!obj) throw Object.assign(new Error('That file is gone'), { status: 404 });
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  const [people, meetings] = await Promise.all([minutesPeople(env.DB), listMeetings(env.DB)]);
  const prev = meetings.filter((x) => x.id !== m.id && !x.notBoard && !x.practice && isDate(x.date) && x.date < m.date).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  const read = await readMinutes(env, { name: f.name, bytes, meeting: m, people, prev });
  if (!readSomething(read)) {
    throw Object.assign(new Error(read.said.chars ? 'Board couldn’t find minutes in that file: no attendance, agenda items, motions or action items. Is it the minutes?' : 'Board couldn’t read that file. Minutes can be a PDF (not a scan) or a Word file.'), { status: 422 });
  }
  // A look only (`dry`): what the minutes would put on the meeting, nothing saved
  if (dry) {
    const would = applyMinutes(m, read, { fileName: f.name, now });
    const board = would.attendance.filter((p) => p.kind === 'board');
    return {
      dry: true, said: read.said,
      read: {
        attendance: { here: board.filter((p) => p.status === 'present' || p.status === 'remote').length, of: board.length },
        notes: would.sections.reduce((n, s) => n + s.items.filter((it) => String(it.notes || '').trim()).length, 0),
        motions: read.motions.length, actions: read.actions.length, ai: read.said.by === 'ai',
      },
      would: { attendance: would.attendance.map((p) => ({ name: p.name, kind: p.kind, status: p.status })), motions: would.motions, actions: would.actions, sections: would.sections.map((s) => ({ title: s.title, items: s.items.map((it) => ({ title: it.title, notes: it.notes })) })), approvedPrev: read.approvedPrev },
    };
  }
  await patchMeeting(env.DB, id, (cur) => applyMinutes(cur, read, { fileName: f.name, now }));
  if (f.kind !== 'minutes' && f.kind !== 'signed') await updateFile(env.DB, fileId, { kind: 'minutes' });
  let approvedPrev = null;
  if (read.approvedPrev && prev && prev.minutes !== 'approved') {
    await approveMinutes(env, prev.id, { on: m.date, by });
    approvedPrev = prev.id;
  }
  const meeting = await getMeeting(env.DB, id);
  const board = meeting.attendance.filter((p) => p.kind === 'board');
  return {
    meeting, approvedPrev,
    read: {
      attendance: { here: board.filter((p) => p.status === 'present' || p.status === 'remote').length, of: board.length },
      notes: meeting.sections.reduce((n, s) => n + s.items.filter((it) => String(it.notes || '').trim()).length, 0),
      motions: read.motions.length, actions: read.actions.length, ai: read.said.by === 'ai',
    },
  };
}
