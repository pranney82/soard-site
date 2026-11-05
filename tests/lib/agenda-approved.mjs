import { ensureAsks } from '../../functions/api/_board-asks.js';

/** The agenda approved, as the chair's review records it: what lets a meeting ahead reach the board */
export async function agendaApproved(DB, id, name = 'Alex Rivera') {
  await ensureAsks(DB);
  const at = new Date().toISOString();
  await DB.prepare(`INSERT INTO board_asks (id, kind, meeting_id, item_id, slug, name, email, title, status, asked_at, in_at, msg_ids, files, updated_at)
    VALUES (?, 'chair', ?, '', 'admin', ?, '', '', 'approved', ?, ?, '[]', '[]', ?)`).bind(`ask_${id}`, id, name, at, at, at).run();
  return id;
}
