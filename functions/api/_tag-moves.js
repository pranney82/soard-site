/**
 * The old tags moved onto the new ones, then retired
 * ===========================================================================
 * Peter, Nov 11 2026: "can you migrate these over too?" Every file on an old
 * tag (.BeforePics, Progress Photos, the ":" construction tags, _Sponsor,
 * .BuildSpecDocs, .WorkingPlans, .FinalPlans, Design Documents,
 * .PricingQuotes, _MakeoverFamily) gets its new tag and loses the old ones:
 *   - a photo or video: Before, During or After by when it was taken (or
 *     recorded) against its job's Demo and Reveal dates (the sorter's pick
 *     when it has one); else, a picture named like a design, plan or cost
 *     (a design board saved as a PNG) goes there; else what its old tag means
 *     (.BeforePics Before; Progress Photos and the ":" tags During; the plan
 *     and design tags Plans or Design);
 *   - anything else: Costs, Design or Plans by ./_tag-rules.js (a private paper
 *     never gets one);
 *   - every old tag comes off; _MakeoverFamily stays on family papers only.
 * A file nothing places is left on no tag (staff only) and listed. A daily
 * log's file moves like any other (outside roles don't see daily logs, so its
 * old tag was all that showed it). A photo whose time couldn't be read and that
 * nothing else places waits for the next pass rather than losing its tag. An
 * old tag no file carries any more is deleted. In Kind, COI and W-9 stay.
 *
 * WRITE on Nov 11 2026 (Peter: "tomorrow?"), after the trial's 631 moves were
 * checked. 25 files a turn, every 2 minutes, on the heartbeat.
 */

import { SOARD_ORG_ID } from './_reveals.js';
import { pave } from './_jt-access.js';
import { tagIds } from './_file-tags.js';
import { fetchTaken, jobDates, stageOf } from './_photo-stages.js';
import { docPick, oldStage, moveFor, isRetiring, isPrivateName } from './_tag-rules.js';

export const WRITE = true; // Nov 11 2026: the trial's moves checked; writing (Peter: "tomorrow?")
const TURN_MS = 2 * 60 * 1000;
const TAGS_EVERY_MS = 60 * 60 * 1000;
const PAGE = 25;
const READS_PER_TURN = PAGE + 5;
const iso = (t) => new Date(t).toISOString();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tag_moves (
    file_id TEXT PRIMARY KEY, name TEXT, kind TEXT, old TEXT, add_tag TEXT, remove TEXT, why TEXT,
    taken TEXT, decided_at TEXT, written_at TEXT)`,
  'CREATE TABLE IF NOT EXISTS tag_moves_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)',
];
const _ready = new WeakSet();
async function ensureSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}
async function getState(DB, key) {
  const v = await DB.prepare('SELECT value FROM tag_moves_state WHERE key = ?').bind(key).first('value');
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}
const putState = (DB, key, value, now) => DB.prepare('INSERT INTO tag_moves_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
  .bind(key, JSON.stringify(value), iso(now)).run();

async function retiringTags(key, fetchImpl) {
  const body = await pave(key, { organization: { $: { id: SOARD_ORG_ID }, fileTags: { $: { size: 100 }, nodes: { id: {}, name: {} } } } }, fetchImpl);
  const nodes = body?.organization?.fileTags?.nodes;
  if (!Array.isArray(nodes)) throw new Error('JobTread sent no tags');
  return nodes.filter((t) => isRetiring(t.name)).map((t) => ({ id: t.id, name: t.name })).sort((a, b) => a.name.localeCompare(b.name));
}

async function tagPage(key, tagId, page, fetchImpl) {
  const body = await pave(key, { fileTag: { $: { id: tagId }, f: { _: 'files', $: { size: PAGE, ...(page ? { page } : {}) }, nextPage: {},
    nodes: { id: {}, name: {}, type: {}, job: { id: {} }, dailyLog: { id: {} }, document: { id: {}, type: {} }, createdByUser: { name: {} },
      url: { $: { original: true } }, fileTags: { $: { size: 10 }, nodes: { id: {}, name: {} } } } } } }, fetchImpl);
  const conn = body?.fileTag?.f;
  if (!conn) throw new Error('JobTread sent no files for a tag');
  return { files: conn.nodes || [], next: conn.nextPage || null };
}

/**
 * Decide one file's move.
 * ctx: { key, fetchImpl, now, reads: { left }, dates: Map(job id → dates), staged: Map(file id → stage), taken: Map(file id → time read before) }
 * → { kind, pick, move, oldNames, taken, wait } (wait: couldn't be read and nothing else places it; tried next pass)
 */
export async function decide(f, ctx) {
  const type = String(f.type || '').toLowerCase();
  const kind = type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : 'doc';
  const tags = f.fileTags?.nodes || [];
  const oldNames = tags.filter((t) => isRetiring(t.name)).map((t) => t.name);
  let pick = null;
  let taken = null;
  let unread = false;
  if (kind === 'doc' || f.document?.id) {
    pick = docPick({ name: f.name, createdBy: f.createdByUser?.name, documentType: f.document?.type }, oldNames);
    // A file on a document is seen with the document: only Costs (staff only) goes on it
    if (f.document?.id && pick.tag && pick.tag !== 'Costs') pick = { tag: null, why: 'on a document' };
  } else if (isPrivateName(f.name)) {
    pick = { tag: null, why: 'a picture of a private paper' };
  } else {
    const staged = ctx.staged.get(f.id);
    if (staged) pick = { tag: staged, why: 'the sorter’s pick' };
    else if (f.job?.id) {
      taken = ctx.taken?.get(f.id) || null;
      if (!taken && f.url) {
        if (ctx.reads.left > 0) {
          ctx.reads.left -= 1;
          try { taken = (await fetchTaken(f.url, ctx.fetchImpl))?.taken || null; } catch { unread = true; }
        } else unread = true;
      }
      if (taken) {
        if (!ctx.dates.has(f.job.id)) ctx.dates.set(f.job.id, await jobDates(ctx.key, f.job.id, ctx.fetchImpl).catch(() => null));
        const d = ctx.dates.get(f.job.id);
        const s = d ? stageOf(taken, { ...d, community: false }, ctx.now) : { stage: null };
        if (s.stage) pick = { tag: s.stage, why: s.why };
      }
    }
    // Undated: a design board or a layout saved as a picture by its name, then the old tag's meaning (a stage, or Design/Plans)
    if (!pick) { const byName = docPick({ name: f.name }); if (byName.tag) pick = byName; }
    if (!pick) { const st = oldStage(oldNames); if (st.tag) pick = st; }
    if (!pick) { const byOld = docPick({ name: f.name }, oldNames); if (byOld.tag) pick = byOld; }
    if (!pick && unread) return { kind, pick: { tag: null, why: 'couldn’t be read yet' }, move: { add: null, remove: [] }, oldNames, taken, wait: true };
    pick ||= { tag: null, why: kind === 'video' ? 'no time recorded, and nothing else places it' : 'no time taken, and nothing else places it' };
  }
  const move = moveFor({ name: f.name, kind, tags }, pick);
  return { kind, pick, move, oldNames, taken };
}

/** The heartbeat's call: every 2 minutes, the next 25 files on an old tag. Never throws. */
export async function maybeMoveTags(env, { fetchImpl = fetch, now = Date.now(), write = WRITE, deadline = Infinity } = {}) {
  const { DB } = env;
  const key = env.JOBTREAD_GRANT_KEY;
  if (!DB || !key) return null;
  try {
    await ensureSchema(DB);
    const next = String(now + TURN_MS);
    const ins = await DB.prepare("INSERT OR IGNORE INTO tag_moves_state (key, value, updated_at) VALUES ('turn', ?, ?)").bind(next, iso(now)).run();
    if (!ins?.meta?.changes) {
      const upd = await DB.prepare("UPDATE tag_moves_state SET value = ?, updated_at = ? WHERE key = 'turn' AND CAST(value AS INTEGER) <= ?").bind(next, iso(now), now).run();
      if (!upd?.meta?.changes) return null;
    }
    let st = await getState(DB, 'cursor');
    if (!st?.at || Date.parse(st.at) < now - TAGS_EVERY_MS || !st.tags) {
      st = { at: iso(now), tags: await retiringTags(key, fetchImpl), tag: st?.tag || 0, page: st?.page || null, passes: st?.passes || 0 };
    }
    if (!st.tags.length) { await putState(DB, 'cursor', st, now); return { done: true }; }
    const tag = st.tags[st.tag % st.tags.length];
    const { files, next: nextPage } = await tagPage(key, tag.id, st.page, fetchImpl);
    const ids = await tagIds(DB);
    // The sorter's picks for these files, when it made one, and the times read on an earlier pass
    const staged = new Map();
    const taken = new Map();
    if (files.length) {
      const marks = files.map(() => '?').join(',');
      const fileIds = files.map((f) => f.id);
      try {
        const { results } = await DB.prepare(`SELECT file_id, stage FROM photo_stages WHERE stage IS NOT NULL AND kind != 'doc' AND file_id IN (${marks})`).bind(...fileIds).all();
        for (const r of results || []) staged.set(r.file_id, r.stage);
      } catch { /* the sorter hasn't made its table yet: every photo is read here */ }
      const { results } = await DB.prepare(`SELECT file_id, taken FROM tag_moves WHERE taken IS NOT NULL AND file_id IN (${marks})`).bind(...fileIds).all();
      for (const r of results || []) taken.set(r.file_id, r.taken);
    }
    const ctx = { key, fetchImpl, now, reads: { left: READS_PER_TURN }, dates: new Map(), staged, taken };
    const save = DB.prepare(`INSERT INTO tag_moves (file_id, name, kind, old, add_tag, remove, why, taken, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET name = excluded.name, kind = excluded.kind, old = excluded.old, add_tag = excluded.add_tag, remove = excluded.remove,
        why = excluded.why, taken = COALESCE(excluded.taken, tag_moves.taken), decided_at = excluded.decided_at`);
    let written = 0;
    let failed = 0;
    let outOfTime = false;
    for (const f of files) {
      // Out of time: the rest of this page next turn (the page isn't advanced)
      if (Date.now() > deadline) { outOfTime = true; break; }
      const d = await decide(f, ctx);
      await save.bind(f.id, f.name || '', d.kind, JSON.stringify(d.oldNames), d.move.add, JSON.stringify(d.move.remove), d.pick.why, d.taken ?? null, iso(now)).run();
      if (write && (d.move.add || d.move.remove.length)) {
        const have = (f.fileTags?.nodes || []).map((t) => t.id);
        const keep = have.filter((id) => !d.move.remove.includes(id));
        const addId = d.move.add ? ids.get(d.move.add) : null;
        const fileTagIds = [...new Set([...keep, ...(addId ? [addId] : [])])].slice(0, 10);
        try {
          await pave(key, { updateFile: { $: { id: f.id, fileTagIds } } }, fetchImpl);
          await DB.prepare('UPDATE tag_moves SET written_at = ? WHERE file_id = ?').bind(iso(now), f.id).run();
          written += 1;
        } catch (e) {
          // One file JobTread won't take doesn't stop the rest: it's still on its old tag, so the next pass tries it again
          failed += 1;
          await putState(DB, 'error', { at: iso(now), error: `${f.name || f.id}: ${String(e?.message || e).slice(0, 250)}` }, now).catch(() => null);
        }
      }
    }
    // Next page, next tag; after the last tag a new pass (and, writing, old tags now empty are deleted).
    // Writing takes files off this tag, so its page is read again until nothing on it moves.
    if (outOfTime || (write && written)) { /* this page again */ } else if (nextPage && files.length) st.page = nextPage;
    else {
      st.page = null;
      st.tag += 1;
      if (st.tag >= st.tags.length) {
        st.tag = 0;
        st.passes += 1;
        if (write) {
          for (const t of st.tags) {
            const body = await pave(key, { fileTag: { $: { id: t.id }, f: { _: 'files', $: { size: 1 }, count: {} } } }, fetchImpl).catch(() => null);
            if (body?.fileTag?.f?.count === 0) await pave(key, { deleteFileTag: { $: { id: t.id } } }, fetchImpl);
          }
          st.at = null; // read the list again next turn
        }
      }
    }
    await putState(DB, 'cursor', st, now);
    return { tag: tag.name, files: files.length, written, failed };
  } catch (e) {
    await putState(DB, 'error', { at: iso(now), error: String(e?.message || e).slice(0, 300) }, now).catch(() => null);
    return null;
  }
}

/** For Site → Automations: counts by old tag and new tag, files nothing places, and how far it's got */
export async function movesFacts(DB) {
  await ensureSchema(DB);
  const { results } = await DB.prepare('SELECT add_tag, remove, kind, why, written_at FROM tag_moves').all();
  const rows = results || [];
  const to = {};
  for (const r of rows) to[r.add_tag || 'none'] = (to[r.add_tag || 'none'] || 0) + 1;
  const cursor = await getState(DB, 'cursor');
  return {
    write: WRITE, files: rows.length, to, written: rows.filter((r) => r.written_at).length,
    // Nothing places it (staff only now), or it waits to be read: not the private papers, which are meant to have no tag
    unplaced: rows.filter((r) => !r.add_tag && !/private paper/.test(r.why || '')).length,
    passes: cursor?.passes || 0, tags: (cursor?.tags || []).map((t) => t.name), error: await getState(DB, 'error'),
    lastAt: (await DB.prepare("SELECT updated_at FROM tag_moves_state WHERE key = 'cursor'").first('updated_at')) || null,
  };
}
