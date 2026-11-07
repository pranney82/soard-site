/**
 * The secretary signs the minutes the board approved, on the board page
 * ===========================================================================
 * Peter, Nov 6 2026: "yes i want this best in class". SOARD's bylaws make the
 * Secretary the keeper of the minutes and don't ask for a signature, so this is
 * the record's finish, never a step anything waits on: once the board approves
 * them, the secretary's "For you" says so, and one signature (typed or drawn, the
 * same one they adopted for the board's papers) makes the signed copy.
 *
 * The signed copy is kept with the meeting as its 'signed' file, where an upload
 * has always gone: a PDF of the minutes as approved, the corrections made before
 * the vote, the signature, and its signing record on the same evidence chain as
 * every paper (./_board-sign.js). A fingerprint of the minutes goes with it, so
 * minutes reopened and changed afterwards say the signature is on the old words.
 */

import { getMeeting, listMeetings, roster, putFile, boardFiles, ensureSchema, keepMark, ID } from './_board.js';
import { sha256Hex, canonical, cleanMark, appendEvents, recordHtml, printPdf, finishPdf, fontFaces, CONSENT_TEXT } from './_board-sign.js';
import { minutesFileOf, meetingName, signsAs, longDate, shortDate, timeRange, MINUTES_SIGN_FROM, docxText } from '../../public/admin/board-shared.js';
import { noteLines } from '../../public/admin/board-minutes-template.js';
import { esc } from './_email-shell.js';

const HOUR = 60 * 60 * 1000;
const TRIES = 3;
const RESULT = { passed: 'Passed', failed: 'Failed', tabled: 'Tabled' };
const no = (message, status, extra) => Object.assign(new Error(message), { status, ...(extra ? { extra } : {}) });
const iso = (t) => new Date(t).toISOString();
const docIdOf = (id) => `minutes:${id}`;
const yearOf = (m) => Number(String(m.date).slice(0, 4));

/** What the board approved, the words that count: nothing about when it was saved or who's marked what done since */
export async function minutesHash(m) {
  // (a minutes file by when it came in and how big it is: naming it something else changes no word of it)
  const file = m.minutesFrom?.typed ? null : minutesFileOf(m);
  return sha256Hex(canonical({
    title: meetingName(m), date: m.date, start: m.start, end: m.end, location: m.location,
    attendance: (m.attendance || []).filter((p) => p.status).map((p) => [p.name, p.status]),
    sections: (m.sections || []).map((s) => ({ title: s.title, notes: s.notes || '', items: s.items.map((it) => [it.title, it.notes || '']) })),
    motions: (m.motions || []).map((x) => [x.text, x.by, x.second, x.result, x.tally?.for ?? null, x.tally?.against ?? null]),
    actions: (m.actions || []).map((a) => [a.text, a.ownerName, a.due]),
    file: file ? [file.size, file.at] : null,
  }));
}

/** The corrections made before the vote, as the record says them */
const correctionsMade = async (DB, id) => ((await DB.prepare("SELECT target, kind, by_name, decided_by, decided_at FROM board_minutes_corrections WHERE meeting_id = ? AND state = 'made' ORDER BY decided_at").bind(id).all()).results || []);

/** The minutes as the board approved them, for the signed copy: what the meeting says, escaped, nothing loaded */
export function minutesPage(m, { corrections = [], onlyCorrections = false } = {}) {
  const names = (status) => (m.attendance || []).filter((p) => p.status === status).map((p) => p.name).join(', ');
  const who = [['Here', names('present')], ['By video', names('remote')], ['Excused', names('excused')], ['Not there', names('absent')]].filter(([, list]) => list);
  const list = (lines) => (lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '');
  const parts = (m.sections || []).map((s, si) => {
    const items = s.items.filter((it) => it.notes);
    if (!items.length && !s.notes) return '';
    return `<h2>${si + 1}. ${esc(s.title || 'Agenda')}</h2>${list(noteLines(s.notes))}${items.map((it) => {
      const n = s.items.indexOf(it) + 1;
      return `<p class="rule">${si + 1}.${n} ${esc(it.title || s.title || 'Item')}${it.confidential ? ' (board only)' : ''}</p>${list(noteLines(it.notes))}`;
    }).join('')}`;
  }).join('');
  const tally = (x) => (x.tally ? `, ${x.tally.for} for, ${x.tally.against} against${x.tally.abstain ? `, ${x.tally.abstain} abstaining` : ''}` : '');
  const motions = (m.motions || []).filter((x) => x.text).map((x) => `${x.text}: ${RESULT[x.result] || 'Recorded'}${tally(x)}.${x.by ? ` Moved by ${x.by}${x.second ? `, seconded by ${x.second}` : ''}.` : ''}`);
  const actions = (m.actions || []).filter((a) => a.text).map((a) => [a.text, a.ownerName, a.due ? `by ${shortDate(a.due)}` : ''].filter(Boolean).join(', '));
  const whereOf = (c) => {
    if (c.kind === 'other') return 'The minutes';
    if (c.kind === 'roll') return 'Who was there';
    const id = c.target.slice(2);
    for (const s of m.sections || []) { if (s.id === id) return s.title || 'A part'; const it = s.items.find((x) => x.id === id); if (it) return it.title || 'An item'; }
    return 'An item';
  };
  const made = corrections.map((c) => `${whereOf(c)}: suggested by ${c.by_name}, made by ${c.decided_by}${c.decided_at ? ` on ${shortDate(c.decided_at.slice(0, 10))}` : ''}.`);
  if (onlyCorrections) return made.length ? `<h2>Corrected before the vote</h2>${list(made)}` : '';
  return [
    `<p>${esc([longDate(m.date), timeRange(m.start, m.end), m.location].filter(Boolean).join(' · '))}</p>`,
    who.length ? `<h2>Who was there</h2>${who.map(([k, v]) => `<p><strong>${k}:</strong> ${esc(v)}</p>`).join('')}` : '',
    parts,
    motions.length ? `<h2>Decisions</h2>${list(motions)}` : '',
    actions.length ? `<h2>Action items</h2>${list(actions)}` : '',
    made.length ? `<h2>Corrected before the vote</h2>${list(made)}` : '',
  ].join('');
}

/**
 * POST { action: 'sign-minutes', meetingId, mark, consent }: the secretary's signature on minutes the board approved.
 * Signing again means something changed (the same words: nothing new). → { name, at, how, mark }
 */
export async function signMinutes(env, id, member, { mark: rawMark = null, consent = false, evidence = {} } = {}, { now = Date.now() } = {}) {
  await ensureSchema(env.DB);
  const { DB } = env;
  if (member?.seat !== 'secretary') throw no('Only the board’s secretary signs the minutes', 403);
  if (!ID.test(String(id || ''))) throw no('Which meeting?', 400);
  const m = await getMeeting(DB, id);
  if (!m || m.practice || m.notBoard || !m.shared) throw no('That meeting isn’t on the board page', 404);
  if (m.minutes !== 'approved') throw no('The board hasn’t approved these yet', 409, { reload: true });
  if (String(m.approvedOn || '') < MINUTES_SIGN_FROM) throw no('These were approved before minutes were signed here', 409);
  const mark = cleanMark(rawMark || {});
  if (typeof mark === 'string') throw no(mark, 400);
  const typed = signsAs(mark.text, member.name);
  if (!typed) throw no(`Sign with your own name, as the board has it: ${member.name}`, 400);
  const marks = await DB.prepare('SELECT * FROM board_member_marks WHERE slug = ?').bind(member.slug).first();
  const consentHash = marks?.consent_hash || await sha256Hex(CONSENT_TEXT);
  if (!marks?.consent_at && !consent) throw no('Tick that you agree to sign electronically, then sign', 409, { consent: true });
  const hash = await minutesHash(m);
  const had = await DB.prepare('SELECT * FROM board_minutes_signed WHERE meeting_id = ?').bind(id).first();
  if (had?.hash === hash) return { name: had.name, at: had.at, how: had.how };
  const at = iso(now);
  const how = mark.type === 'drawn' ? 'drawn' : 'typed';
  const year = yearOf(m);
  const kept = { type: mark.type, style: mark.style, text: typed, initials: mark.initials, ...(mark.path ? { path: mark.path } : {}) };
  const done = await appendEvents(DB, async () => {
    // (asked again if another device got to the chain first: its signature is the signature)
    const now2 = await DB.prepare('SELECT hash, name, at, how FROM board_minutes_signed WHERE meeting_id = ?').bind(id).first();
    if (now2?.hash === hash) return { result: { name: now2.name, at: now2.at, how: now2.how, same: true } };
    return {
    stmts: [DB.prepare(`INSERT OR REPLACE INTO board_minutes_signed (meeting_id, slug, name, title, at, how, mark, hash, signer_email, ip, device, signin_at, consent_hash, event_hash, file_id, record_tries, record_claim_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL)`).bind(id, member.slug, typed, member.title || 'Board Secretary', at, how, JSON.stringify(kept), hash, evidence.signerEmail || member.email || '', evidence.ip || '', evidence.device || '', evidence.signinAt || '', consentHash)],
    events: [{ kind: 'signed', docId: docIdOf(id), slug: member.slug, year, version: 0, at, by: member.email || '', ip: evidence.ip, device: evidence.device, detail: { hash, mark: { type: mark.type, style: mark.style }, consentHash } }],
    result: {},
    };
  });
  if (done?.same) return { name: done.name, at: done.at, how: done.how };
  const ev = await DB.prepare("SELECT hash FROM board_sign_events WHERE doc_id = ? AND kind = 'signed' ORDER BY seq DESC LIMIT 1").bind(docIdOf(id)).first();
  await DB.prepare('UPDATE board_minutes_signed SET event_hash = ? WHERE meeting_id = ?').bind(ev?.hash || '', id).run();
  await keepMark(DB, member, { mark, typed, at, first: !marks?.consent_at, evidence, consentHash, docId: docIdOf(id), year, version: 0 });
  return { name: typed, at, how, mark: kept };
}

/**
 * The signed copy, made once from a signature (claimed: two makers never make two), kept as the meeting's 'signed' file.
 * Minutes kept as a PDF: its own pages, then the signature. As a Word file someone sent: its words. Typed: the meeting.
 * `render(html)`: a stand-in printer (tests) → { built, id } | { built: false, error }
 */
export async function buildMinutesRecord(env, id, { launch = null, render = null, now = Date.now() } = {}) {
  const { DB } = env;
  if (!render && !launch && !env.BROWSER) return { built: false, error: 'no browser' };
  const claim = await DB.prepare('UPDATE board_minutes_signed SET record_claim_at = ?1, record_tries = COALESCE(record_tries, 0) + 1 WHERE meeting_id = ?2 AND file_id IS NULL AND (record_claim_at IS NULL OR record_claim_at < ?3)').bind(iso(now), id, iso(now - 3 * 60_000)).run();
  if (!(claim?.meta?.changes ?? claim?.changes)) return { built: false, error: 'claimed' };
  const sig = await DB.prepare('SELECT * FROM board_minutes_signed WHERE meeting_id = ?').bind(id).first();
  try {
    const m = await getMeeting(DB, id);
    if (!m) return { built: false, error: 'gone' };
    const corrections = await correctionsMade(DB, id);
    // (the file the board can read: a staff-only one never goes into a copy the board opens)
    const file = m.minutesFrom?.typed ? null : minutesFileOf(m);
    const row = file ? await DB.prepare('SELECT r2_key, type FROM board_files WHERE id = ?').bind(file.id).first() : null;
    const obj = row ? await boardFiles(env)?.get(row.r2_key) : null;
    const bytes = obj ? new Uint8Array(await new Response(obj.body).arrayBuffer()) : null;
    let source = null;
    let page = minutesPage(m, { corrections });
    if (bytes && row.type === 'application/pdf') {
      source = bytes;
      page = `<p>The minutes as the board approved them are the pages before this one.</p>${minutesPage(m, { corrections, onlyCorrections: true })}`;
    } else if (bytes) {
      const words = await docxText(bytes).catch(() => '');
      if (words) page = `${String(words).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('')}${minutesPage(m, { corrections, onlyCorrections: true })}`;
    }
    const name = meetingName(m);
    const doc = { id: docIdOf(id), title: `Minutes of the ${name}` };
    const year = yearOf(m);
    const row2 = { ...sig, doc_id: docIdOf(id), year, version: 0 };
    const events = (await DB.prepare('SELECT * FROM board_sign_events WHERE doc_id = ? ORDER BY seq').bind(docIdOf(id)).all()).results || [];
    const marks = await DB.prepare('SELECT consent_at FROM board_member_marks WHERE slug = ?').bind(sig.slug).first().catch(() => null);
    const approved = m.approvedOn ? `Approved by the board on ${longDate(m.approvedOn)}.` : 'Approved by the board.';
    const html = recordHtml({
      doc, body: '', sig: row2, events: events.map((e) => { try { return { ...e, detail: JSON.parse(e.detail || 'null') }; } catch { return e; } }), fonts: await fontFaces(env), signedHash: sig.event_hash || '',
      consent: marks?.consent_at ? { at: marks.consent_at } : null, page: { html: page, sub: `${longDate(m.date)}. ${approved}`, agree: `${approved} Signed by the Secretary of the Board.`, seat: sig.title || 'Board Secretary' },
    });
    const printed = render ? await render(html) : await printPdf(env, html, { launch });
    // (the board can open this: where it was signed from stays in the signature's row and on the chain, never in the file)
    const out = await finishPdf(printed, { doc, sig: row2, body: '', source, evidence: { signature: { name: sig.name, title: sig.title, at: sig.at, how: sig.how, minutesHash: sig.hash, event: sig.event_hash }, consent: marks?.consent_at || null } });
    const put = await putFile(env, { ownerType: 'meeting', ownerId: id, file: new File([out], `Signed minutes, ${name}.pdf`, { type: 'application/pdf' }), kind: 'signed', by: 'SOARD board page' });
    await DB.prepare('UPDATE board_minutes_signed SET file_id = ?, record_claim_at = NULL WHERE meeting_id = ?').bind(put.id, id).run();
    return { built: true, id: put.id };
  } catch (err) {
    // (its try counted as it began; the claim left as when it was tried, so the next waits its turn)
    console.error('[board] signed minutes', err?.message || err);
    return { built: false, error: String(err?.message || err) };
  }
}

/** The heartbeat: a signed copy that didn't get made (the answer ended, the browser was busy): soon three times, then every six hours */
export async function maybeFinishSignedMinutes(env, { now = Date.now(), limit = 1 } = {}) {
  const rows = (await env.DB.prepare('SELECT meeting_id, record_tries, record_claim_at FROM board_minutes_signed WHERE file_id IS NULL').all()).results || [];
  let made = 0;
  for (const r of rows) {
    if (made >= limit) break;
    if ((Number(r.record_tries) || 0) >= TRIES && r.record_claim_at && now - Date.parse(r.record_claim_at) < 6 * HOUR) continue;
    if ((await buildMinutesRecord(env, r.meeting_id, { now })).built) made += 1;
  }
  return made;
}

/** Who signed each meeting's minutes, for the pages: `changed`, the words aren't the ones they signed any more → { meetingId: { name, at, how, made, changed } } */
export async function signedMinutes(DB, meetings = null) {
  await ensureSchema(DB);
  const rows = (await DB.prepare('SELECT meeting_id, name, at, how, hash, file_id FROM board_minutes_signed').all()).results || [];
  if (!rows.length) return {};
  const all = meetings || await listMeetings(DB);
  const out = {};
  for (const r of rows) {
    const m = all.find((x) => x.id === r.meeting_id);
    if (!m) continue;
    out[r.meeting_id] = { name: r.name, at: r.at, how: r.how, made: !!r.file_id, changed: (await minutesHash(m)) !== r.hash };
  }
  return out;
}

/** The secretary, for a page that says who signs: nobody in the seat, nobody to ask */
export const secretaryOf = async (DB) => (await roster(DB)).board.find((p) => p.seat === 'secretary') || null;
