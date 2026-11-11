/**
 * The old tags moved onto the new ones, then retired
 * ===========================================================================
 * Peter, Nov 11 2026: "can you migrate these over too?" Every file on an old
 * tag (.BeforePics, Progress Photos, the ":" construction tags, _Sponsor,
 * .BuildSpecDocs, .WorkingPlans, .FinalPlans, Design Documents,
 * .PricingQuotes, _MakeoverFamily) gets its new tag and loses the old ones:
 *   - a photo or video: Before, During or After by when it was taken against
 *     its job's Demo and Reveal dates (the sorter's pick when it has one),
 *     else what its old tag means (.BeforePics Before; Progress Photos and the
 *     ":" tags During);
 *   - anything else: Costs, Design or Plans by ./_tag-rules.js (a private paper
 *     never gets one, and comes off a sharing tag);
 *   - _MakeoverFamily stays on family papers only.
 * A file nothing places keeps its old tags and is listed. A daily log's file is
 * left as it is (it's shared with whoever the log is). An old tag no file
 * carries any more is deleted. In Kind, COI and W-9 stay.
 *
 * WRITE is off (Nov 11 2026): every planned move is recorded (D1 tag_moves)
 * and counted on Site → Automations, and nothing is written until the picks
 * are checked. 25 files a turn, every 2 minutes, on the heartbeat.
 */

import { SOARD_ORG_ID } from './_reveals.js';
import { pave } from './_jt-access.js';
import { tagIds } from './_file-tags.js';
import { fetchTaken, jobDates, stageOf } from './_photo-stages.js';
import { docPick, oldStage, moveFor, isRetiring, isPrivateName } from './_tag-rules.js';

export const WRITE = false; // Nov 11 2026: moves recorded, nothing written, until they're checked
const TURN_MS = 2 * 60 * 1000;
const TAGS_EVERY_MS = 60 * 60 * 1000;
const PAGE = 25;
const READS_PER_TURN = 20;
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

/** Decide one file's move. ctx: { key, fetchImpl, now, reads: { left }, dates: Map(job id → dates), staged: Map(file id → stage) } */
export async function decide(f, ctx) {
  const type = String(f.type || '').toLowerCase();
  const kind = type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : 'doc';
  const tags = f.fileTags?.nodes || [];
  const oldNames = tags.filter((t) => isRetiring(t.name)).map((t) => t.name);
  if (f.dailyLog?.id) return { kind, pick: { tag: null, why: 'a daily log’s file (left as it is)' }, move: { add: null, remove: [] }, oldNames, taken: null };
  let pick;
  let taken = null;
  if (kind === 'doc') {
    pick = docPick({ name: f.name, createdBy: f.createdByUser?.name, documentType: f.document?.type }, oldNames);
    // A file on a document is seen with the document: only Costs (staff only) goes on it
    if (f.document?.id && pick.tag && pick.tag !== 'Costs') pick = { tag: null, why: 'on a document' };
  } else if (isPrivateName(f.name)) {
    pick = { tag: null, why: 'a picture of a private paper' };
  } else {
    const staged = ctx.staged.get(f.id);
    if (staged) pick = { tag: staged, why: 'the sorter’s pick' };
    else if (kind === 'photo' && f.job?.id && f.url && ctx.reads.left > 0) {
      ctx.reads.left -= 1;
      try {
        const r = await fetchTaken(f.url, ctx.fetchImpl);
        taken = r?.taken || null;
        if (taken) {
          if (!ctx.dates.has(f.job.id)) ctx.dates.set(f.job.id, await jobDates(ctx.key, f.job.id, ctx.fetchImpl).catch(() => null));
          const d = ctx.dates.get(f.job.id);
          const s = d ? stageOf(taken, { ...d, community: false }, ctx.now) : { stage: null };
          if (s.stage) pick = { tag: s.stage, why: s.why };
        }
      } catch { /* the old tag's meaning, below */ }
    }
    pick ||= oldStage(oldNames);
  }
  const move = moveFor({ name: f.name, kind, tags }, pick);
  return { kind, pick, move, oldNames, taken };
}

/** The heartbeat's call: every 2 minutes, the next 25 files on an old tag. Never throws. */
export async function maybeMoveTags(env, { fetchImpl = fetch, now = Date.now(), write = WRITE } = {}) {
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
    // The sorter's picks for these files, when it made one
    const staged = new Map();
    if (files.length) {
      try {
        const { results } = await DB.prepare(`SELECT file_id, stage FROM photo_stages WHERE stage IS NOT NULL AND kind != 'doc' AND file_id IN (${files.map(() => '?').join(',')})`).bind(...files.map((f) => f.id)).all();
        for (const r of results || []) staged.set(r.file_id, r.stage);
      } catch { /* the sorter hasn't made its table yet: every photo is read here */ }
    }
    const ctx = { key, fetchImpl, now, reads: { left: READS_PER_TURN }, dates: new Map(), staged };
    const save = DB.prepare(`INSERT INTO tag_moves (file_id, name, kind, old, add_tag, remove, why, taken, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET name = excluded.name, kind = excluded.kind, old = excluded.old, add_tag = excluded.add_tag, remove = excluded.remove,
        why = excluded.why, taken = COALESCE(excluded.taken, tag_moves.taken), decided_at = excluded.decided_at`);
    let written = 0;
    for (const f of files) {
      const d = await decide(f, ctx);
      await save.bind(f.id, f.name || '', d.kind, JSON.stringify(d.oldNames), d.move.add, JSON.stringify(d.move.remove), d.pick.why, d.taken ?? null, iso(now)).run();
      if (write && (d.move.add || d.move.remove.length)) {
        const have = (f.fileTags?.nodes || []).map((t) => t.id);
        const keep = have.filter((id) => !d.move.remove.includes(id));
        const addId = d.move.add ? ids.get(d.move.add) : null;
        const fileTagIds = [...new Set([...keep, ...(addId ? [addId] : [])])].slice(0, 10);
        await pave(key, { updateFile: { $: { id: f.id, fileTagIds } } }, fetchImpl);
        await DB.prepare('UPDATE tag_moves SET written_at = ? WHERE file_id = ?').bind(iso(now), f.id).run();
        written += 1;
      }
    }
    // Next page, next tag; after the last tag a new pass (and, writing, old tags now empty are deleted)
    if (nextPage && files.length) st.page = nextPage;
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
    return { tag: tag.name, files: files.length, written };
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
    unplaced: rows.filter((r) => !r.add_tag && r.remove === '[]').length,
    passes: cursor?.passes || 0, tags: (cursor?.tags || []).map((t) => t.name), error: await getState(DB, 'error'),
    lastAt: (await DB.prepare("SELECT updated_at FROM tag_moves_state WHERE key = 'cursor'").first('updated_at')) || null,
  };
}
