/**
 * The secretary's notes, walked: hundreds of seeded random runs of typing, clearing, marking, sending and a founder's
 * fixes in Board through applyNotes (functions/api/_board-notes.js), with what must always hold checked after every
 * send. Fixed scripts only walk the paths someone thought of. Made-up people only (the repo is public).
 * Run: node --test tests/board-notes-walk.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNotes } from '../functions/api/_board-notes.js';
import { cleanMeeting } from '../public/admin/board-shared.js';

const rng = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const PEOPLE = ['alex-rivera', 'sam-ortiz', 'kim-park', 'ada-lane'].map((slug) => ({ slug, name: slug.replace('-', ' '), org: '', kind: 'board' }));
const start = () => cleanMeeting({
  id: 'm_walk00001', date: '2026-11-05', start: '08:00', end: '10:00', shared: true,
  attendance: PEOPLE.map((p) => ({ slug: p.slug, name: p.name, kind: 'board' })),
  sections: [
    { id: 's_call', title: 'Call to order', items: [{ id: 'i_roll', title: 'Roll call' }] },
    { id: 's_new', title: 'New business', items: [
      { id: 'i_budget', title: 'Budget', notes: 'Background from the treasurer', motion: 'Approve the 2027 budget' },
      { id: 'i_gala', title: 'Gala', notes: '- Tickets on sale\n- Venue booked' },
    ] },
    { id: 's_open', title: 'Open forum', items: [] },
  ],
});
const OPEN_ITEMS = ['i_roll', 'i_budget', 'i_gala'];
const VOTES = ['i_budget', 'v_walk00001', 'v_walk00002', 'v_walk00003'];
const ACTIONS = ['a_walk00001', 'a_walk00002', 'a_walk00003'];
const HOW = ['present', 'remote', 'excused', 'absent'];

/** A send, and what comes back the way it does for real: through cleanMeeting and JSON */
const send = (cur, notes, sent) => {
  const r = applyNotes(cur, notes, { sent, people: PEOPLE, taker: 'kim park', fileName: 'Minutes.docx', now: Date.parse('2026-11-05T15:00:00Z') });
  return { ...r, next: cleanMeeting(JSON.parse(JSON.stringify(r.next))), sent: JSON.parse(JSON.stringify(r.sent)) };
};
const shape = (m) => ({
  notes: m.sections.map((s) => [s.notes || '', ...s.items.map((it) => it.notes || '')]),
  people: m.attendance.map((p) => [p.key, p.status || '']).sort(),
  motions: m.motions.map((x) => [x.id, x.text, x.by, x.second, x.result, x.tally?.for ?? '']).sort(),
  actions: m.actions.map((x) => [x.id, x.text, x.owner, x.due]).sort(),
});
const noteOn = (m, id) => m.sections.flatMap((s) => s.items).find((it) => it.id === id)?.notes || '';

function walk(seed, { founder }) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const original = start();
  let cur = start();
  let notes = {};
  let sent = null;
  // What a founder set in Board, which no send may undo
  const fixedNote = new Map();
  const fixedMotion = new Map();
  const goneMotions = new Set();
  const goneActions = new Set();

  const check = (label) => {
    const out = send(cur, notes, sent);
    const twice = send(out.next, notes, out.sent);
    assert.deepEqual(shape(twice.next), shape(out.next), `${label}: sending the same thing again changes nothing`);
    const seen = (rows) => assert.equal(new Set(rows.map((x) => x.id)).size, rows.length, `${label}: no row twice`);
    seen(out.next.motions);
    seen(out.next.actions);
    assert.equal(new Set(out.next.attendance.map((p) => p.key)).size, out.next.attendance.length, `${label}: nobody on the list twice`);
    for (const [id, text] of fixedNote) assert.equal(noteOn(out.next, id), text, `${label}: a founder’s words under ${id} stay`);
    for (const [id, text] of fixedMotion) assert.equal(out.next.motions.find((x) => x.id === id)?.text, text, `${label}: a founder’s motion ${id} stays`);
    for (const id of goneMotions) assert.ok(!out.next.motions.some((x) => x.id === id), `${label}: a motion a founder deleted doesn’t come back`);
    for (const id of goneActions) assert.ok(!out.next.actions.some((x) => x.id === id), `${label}: an action a founder deleted doesn’t come back`);
    // Everything typed that Board hasn't touched is on the meeting
    for (const id of OPEN_ITEMS) {
      const typed = String(notes[`n:${id}`] || '').trim();
      if (typed && !fixedNote.has(id)) assert.equal(noteOn(out.next, id), typed, `${label}: what’s typed under ${id} is on the meeting`);
    }
    cur = out.next;
    sent = out.sent;
    // A row taken off the draft and sent is over with: one typed after it is a new row (the panel gives it a new id)
    const onDraft = (id) => `m:${id.replace(/^vn_/, '')}` in notes;
    for (const id of goneMotions) if (!onDraft(id)) goneMotions.delete(id);
    for (const id of fixedMotion.keys()) if (!onDraft(id)) fixedMotion.delete(id);
    for (const id of goneActions) if (!(`a:${id}` in notes)) goneActions.delete(id);
  };

  for (let step = 0; step < 40; step += 1) {
    const roll = r();
    if (roll < 0.22) notes[`n:${pick(OPEN_ITEMS)}`] = `Typed ${seed}.${step}`;
    else if (roll < 0.3) delete notes[`n:${pick(OPEN_ITEMS)}`];
    else if (roll < 0.36) notes['n:s_open'] = `A question ${step}`;
    else if (roll < 0.46) notes[`r:${pick(PEOPLE).slug}`] = pick(HOW);
    else if (roll < 0.58) { const id = pick(VOTES); notes[`m:${id}`] = { text: id[0] === 'v' ? `Motion ${id}` : '', by: 'alex rivera', result: pick(['passed', 'failed', 'tabled']), for: 3, against: 1 }; } else if (roll < 0.63) delete notes[`m:${pick(VOTES)}`];
    else if (roll < 0.73) notes[`a:${pick(ACTIONS)}`] = { text: `Do ${step}`, owner: 'alex-rivera' };
    else if (roll < 0.78) delete notes[`a:${pick(ACTIONS)}`];
    else if (roll < 0.9) check(`seed ${seed} step ${step}`);
    else if (founder && sent) {
      // A founder's fix in Board, between sends
      const what = r();
      cur = structuredClone(cur);
      if (what < 0.34) {
        const id = pick(OPEN_ITEMS);
        const text = `Founder ${seed}.${step}`;
        for (const s of cur.sections) for (const it of s.items) if (it.id === id) it.notes = text;
        fixedNote.set(id, text);
      } else if (what < 0.67 && cur.motions.length) {
        const x = pick(cur.motions);
        if (r() < 0.5) { cur.motions = cur.motions.filter((y) => y !== x); goneMotions.add(x.id); fixedMotion.delete(x.id); } else { x.text = `Fixed ${seed}.${step}`; fixedMotion.set(x.id, x.text); }
      } else if (cur.actions.length) {
        const x = pick(cur.actions);
        cur.actions = cur.actions.filter((y) => y !== x);
        goneActions.add(x.id);
      }
    }
  }
  check(`seed ${seed} last`);
  if (!founder) {
    // Everything taken back out and sent: the meeting is as it was
    notes = {};
    const out = send(cur, notes, sent);
    assert.deepEqual(shape(out.next), shape(original), `seed ${seed}: an empty send gives the meeting back`);
  }
}

test('typing, clearing, sending and sending again, 300 walks: the same words give the same meeting, and an empty send gives it back', () => {
  for (let seed = 1; seed <= 300; seed += 1) walk(seed, { founder: false });
});

test('with a founder fixing things in Board between sends, 300 walks: nothing they set is undone, nothing doubles', () => {
  for (let seed = 1001; seed <= 1300; seed += 1) walk(seed, { founder: true });
});
