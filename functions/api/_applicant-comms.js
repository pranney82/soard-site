/**
 * Applicant messages in JobTread (replaces the Zapier Zaps)
 * ===========================================================================
 * Until Oct 2026 two Zaps hung off JobTread's account webhooks and posted, as
 * the Qualification Committee user:
 *   - new account: "Application Status" (the "under review" note, emailed to
 *     the primary parent) and "Child's Medical Condition" (an internal AI
 *     summary of the Diagnosis field)
 *   - Status → In Review: "Application In Review" (emailed)
 *   - Status → Approved / Denied: "Application Decision" (emailed)
 *   - Status moved backwards: an internal "Moved back to <status>" note
 * They kept a Zapier Table row per account as a run-once flag. This module
 * does the same work from site code, with the same wording.
 *
 * Family messages are comments assigned to the account's primary contact:
 * JobTread emails them, and the family's replies thread back onto the account.
 * Posted with JOBTREAD_QC_GRANT_KEY (a grant made while logged in as the
 * Qualification Committee user) so they read as before; until that key is in
 * Cloudflare they fall back to the site's own JOBTREAD_GRANT_KEY.
 *
 * Run once: each (account, kind) is claimed in D1 before posting, and the
 * account's existing comments are checked too, so accounts from the Zap era
 * never get a second copy.
 *
 * Woken by a JobTread workflow (customerCreatedOrUpdated, Status or Diagnosis
 * changed, not by the site's grant) posting { eventId, accountId,
 * previousStatus, nextStatus, status } to /api/applicant-sync (previous/next
 * are "null" unless Status itself changed). The body only says which
 * account to look at; everything is re-read from JobTread. Accounts made by
 * the site's own application form are left to ./_applications.js, which posts
 * their welcome with the PDF attached.
 */

import { pave, SOARD_ORG_ID } from './_reveals.js';
import { DEFAULT_MESSAGES, renderMessage } from './_application-form.js';
import { getLiveForm } from './_application-forms.js';

export const FIELD_STATUS = '22P46wDp3NLd';      // customer: Applied / In Review / Approved / Denied
export const FIELD_DIAGNOSIS = '22P46st8HNPY';   // customer: text
export const FIELD_CONTACT_EMAIL = '22NJw43QvHeJ';
export const FIELD_CONTACT_PHONE = '22NJw43UauSc';
export const QC_USER_ID = '22P5r2x8FPiK';        // "Qualification Committee"
export const SITE_GRANT_ID = '22PgGhFHkmbz';     // "soard-site-CF", skipped by the workflow
// First-contact messages (welcome, medical note) only for accounts created after
// the site took over from the Zaps; older accounts keep what the Zaps posted.
// Status messages go to any account, checked against what it already has.
export const INTAKE_SINCE = '2026-10-19T00:00:00Z';

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const RANK = { '': 0, Applied: 1, 'In Review': 2, Approved: 3, Denied: 3 };

export const COMMENT_NAMES = {
  welcome: 'Application Status',
  medical: "Child's Medical Condition",
  inReview: 'Application In Review',
  approved: 'Application Decision',
  denied: 'Application Decision',
};

/**
 * The family messages' wording lives with the form (Admin → Applications →
 * Messages); the built-in wording is the Zaps' (stray typos fixed). This
 * renders one for an account.
 */
export async function familyMessage(env, kind, { parent, child, withCopy = false } = {}) {
  const live = await getLiveForm(env.DB);
  const messages = { ...DEFAULT_MESSAGES, ...(live.definition?.messages || {}) };
  return renderMessage(messages[kind], { parent, child, copyNote: withCopy ? messages.copyNote : '' });
}

/** Which already-posted comment counts as this kind having been sent */
const ALREADY_SENT = {
  welcome: (c) => c.name === COMMENT_NAMES.welcome,
  medical: (c) => c.name === COMMENT_NAMES.medical,
  inReview: (c) => c.name === COMMENT_NAMES.inReview,
  approved: (c) => c.name === COMMENT_NAMES.approved && /has been approved/i.test(c.message || ''),
  denied: (c) => c.name === COMMENT_NAMES.denied && /unable to move forward/i.test(c.message || ''),
};

const KIND_FOR_STATUS = { 'In Review': 'inReview', Approved: 'approved', Denied: 'denied' };

// ─── D1 ─────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS applicant_comms (
    account_id TEXT NOT NULL, kind TEXT NOT NULL, comment_id TEXT, state TEXT NOT NULL,
    detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, kind))`,
  // Every wake-up from JobTread, newest first in the admin (last 500 kept)
  `CREATE TABLE IF NOT EXISTS applicant_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, account_id TEXT, previous_status TEXT,
    status TEXT, actions TEXT, error TEXT, created_at TEXT NOT NULL)`,
];
const _schemaReady = new WeakSet();
export async function ensureCommsSchema(DB) {
  if (_schemaReady.has(DB)) return;
  await DB.batch(SCHEMA.map(sql => DB.prepare(sql)));
  _schemaReady.add(DB);
}

const CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Claim (account, kind) so only one caller posts it. A 'sending' claim older
 * than CLAIM_STALE_MS (a crashed run) can be taken over.
 */
async function claim(DB, accountId, kind, now) {
  const at = new Date(now).toISOString();
  const ins = await DB.prepare(`INSERT OR IGNORE INTO applicant_comms (account_id, kind, state, created_at, updated_at) VALUES (?, ?, 'sending', ?, ?)`)
    .bind(accountId, kind, at, at).run();
  if (ins?.meta?.changes > 0) return true;
  const stale = new Date(now - CLAIM_STALE_MS).toISOString();
  const upd = await DB.prepare(`UPDATE applicant_comms SET state = 'sending', updated_at = ? WHERE account_id = ? AND kind = ? AND (state = 'failed' OR (state = 'sending' AND updated_at < ?))`)
    .bind(at, accountId, kind, stale).run();
  return upd?.meta?.changes > 0;
}

async function settle(DB, accountId, kind, state, { commentId = null, detail = null } = {}, now = Date.now()) {
  await DB.prepare(`UPDATE applicant_comms SET state = ?, comment_id = COALESCE(?, comment_id), detail = ?, updated_at = ? WHERE account_id = ? AND kind = ?`)
    .bind(state, commentId, detail ? String(detail).slice(0, 500) : null, new Date(now).toISOString(), accountId, kind).run();
}

export async function commsFor(DB, accountId) {
  await ensureCommsSchema(DB);
  const { results } = await DB.prepare('SELECT kind, state, comment_id, detail, updated_at FROM applicant_comms WHERE account_id = ?').bind(accountId).all();
  return Object.fromEntries((results || []).map(r => [r.kind, r]));
}

// ─── JobTread ───────────────────────────────────────────────────────

/** The grant family messages are posted with */
export function qcGrant(env) {
  return env.JOBTREAD_QC_GRANT_KEY || env.JOBTREAD_GRANT_KEY;
}

const fieldValue = (node, id) => node?.customFieldValues?.nodes?.find(v => v.customField?.id === id)?.value ?? null;

/** Everything the messages need about one account, or null if it isn't a SOARD customer */
export async function readApplicant(env, accountId, fetchImpl = fetch) {
  const contactQuery = {
    id: {}, name: {},
    customFieldValues: { $: { where: [['customField', 'id'], 'in', [FIELD_CONTACT_EMAIL, FIELD_CONTACT_PHONE]] }, nodes: { value: {}, customField: { id: {} } } },
  };
  const data = await pave(env.JOBTREAD_GRANT_KEY, {
    account: {
      $: { id: accountId },
      id: {}, name: {}, type: {}, createdAt: {},
      organization: { id: {} },
      customFieldValues: { $: { where: [['customField', 'id'], 'in', [FIELD_STATUS, FIELD_DIAGNOSIS]] }, nodes: { value: {}, customField: { id: {} } } },
      primaryContact: contactQuery,
      contacts: { $: { size: 10 }, nodes: contactQuery },
      comments: {
        $: { size: 50, where: ['name', 'in', [...new Set(Object.values(COMMENT_NAMES))]] },
        nodes: { id: {}, name: {}, message: {} },
      },
    },
  }, fetchImpl);
  const a = data?.account;
  if (!a || a.type !== 'customer' || a.organization?.id !== SOARD_ORG_ID) return null;
  const contact = (c) => c && { id: c.id, name: c.name, email: fieldValue(c, FIELD_CONTACT_EMAIL), phone: fieldValue(c, FIELD_CONTACT_PHONE) };
  const contacts = (a.contacts?.nodes || []).map(contact);
  const primary = contact(a.primaryContact) || contacts[0] || null;
  return {
    id: a.id,
    name: a.name,
    createdAt: a.createdAt,
    status: fieldValue(a, FIELD_STATUS) || '',
    diagnosis: fieldValue(a, FIELD_DIAGNOSIS) || '',
    primary,
    contacts,
    comments: a.comments?.nodes || [],
  };
}

/**
 * Post one comment on an account. `assignTo` ({ name, email }) makes it a
 * family message JobTread emails; without it the comment is internal.
 * `uploadRequestIds` attach files (from createUploadRequest).
 */
export async function postAccountComment(env, { accountId, name, message, assignTo = null, uploadRequestIds = [], grant = null }, fetchImpl = fetch) {
  const input = {
    targetType: 'account', targetId: accountId, message: String(message).slice(0, 4096),
    isVisibleToInternalRoles: true, isVisibleToCustomerRoles: false, isVisibleToVendorRoles: false,
  };
  if (name) input.name = name;
  if (assignTo?.email) input.assignees = [{ name: assignTo.name || assignTo.email, emailAddress: assignTo.email, accountType: 'customer' }];
  if (uploadRequestIds.length) input.files = uploadRequestIds.map(f => ({ name: f.name, uploadRequestId: f.id }));
  const out = await pave(grant || qcGrant(env), { createComment: { $: input, createdComment: { id: {} } } }, fetchImpl);
  return out?.createComment?.createdComment?.id || null;
}

// ─── Medical summary (Workers AI) ───────────────────────────────────

const MEDICAL_PROMPT = `You write short, plain-language notes for the staff of a children's charity that builds accessible bedrooms, bathrooms and therapy rooms for children with long-term illnesses or special needs. Staff read your note to understand a child's diagnosis before meeting the family.

Given the diagnosis exactly as a parent wrote it, reply with JSON only:
{"summary": "<two or three sentences: what the condition is, in everyday words>", "description": "<one paragraph, five to seven sentences: how it typically affects a child's body, movement, communication, senses or daily care, and what that can mean at home>"}

If the parent listed several conditions, cover each one briefly in both fields. Do not guess about this particular child, give medical advice, or mention treatment costs. If the text is not a recognizable condition, say so plainly in the summary and leave the description empty.`;

/** The "Child's Medical Condition" note, or null when the model is unavailable. Never throws. */
export async function medicalNote(env, diagnosis) {
  const dx = String(diagnosis || '').trim().slice(0, 1500);
  if (!dx || !env.AI) return null;
  let timer;
  try {
    const out = await Promise.race([
      env.AI.run(AI_MODEL, {
        messages: [{ role: 'system', content: MEDICAL_PROMPT }, { role: 'user', content: `Diagnosis: ${dx}` }],
        max_tokens: 700,
        temperature: 0.2,
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 20000); }),
    ]);
    const text = typeof out === 'string' ? out : (out?.response ?? JSON.stringify(out));
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const summary = String(j.summary || '').trim();
    if (!summary) return null;
    const description = String(j.description || '').trim();
    return `*Diagnosis*: ${dx}\n\n*Summary:* ${summary}${description ? `\n\n*Description:* ${description}` : ''}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Sending ────────────────────────────────────────────────────────

/**
 * Send one kind of message to an account once. Returns
 * 'sent' | 'already' | 'busy' | 'skipped: <why>' | 'failed: <why>'.
 */
async function sendOnce(env, applicant, kind, build, { assign = false, uploadRequestIds = [], fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  if (applicant.comments.some(ALREADY_SENT[kind] || (() => false))) {
    await claim(DB, applicant.id, kind, now).then(won => won && settle(DB, applicant.id, kind, 'already', { detail: 'posted before (Zap era or by hand)' }, now));
    return 'already';
  }
  if (assign && !applicant.primary?.email) return 'skipped: no contact email';
  const message = await build();
  if (!message) return 'skipped: nothing to say';
  if (!(await claim(DB, applicant.id, kind, now))) {
    const row = (await commsFor(DB, applicant.id))[kind];
    return row?.state === 'sending' ? 'busy' : 'already';
  }
  try {
    const commentId = await postAccountComment(env, {
      accountId: applicant.id,
      name: COMMENT_NAMES[kind],
      message,
      assignTo: assign ? { name: applicant.primary.name, email: applicant.primary.email } : null,
      uploadRequestIds,
    }, fetchImpl);
    await settle(DB, applicant.id, kind, 'sent', { commentId }, now);
    return 'sent';
  } catch (e) {
    await settle(DB, applicant.id, kind, 'failed', { detail: e.message }, now);
    return `failed: ${e.message}`;
  }
}

/** The first-contact pair: the welcome to the family and the medical note for staff */
export async function sendIntake(env, applicant, { uploadRequestIds = [], fetchImpl = fetch, now = Date.now() } = {}) {
  const parent = applicant.primary?.name || 'Hello';
  const welcome = await sendOnce(env, applicant, 'welcome',
    () => familyMessage(env, 'welcome', { parent, child: applicant.name, withCopy: uploadRequestIds.length > 0 }),
    { assign: true, uploadRequestIds, fetchImpl, now });
  const medical = applicant.diagnosis
    ? await sendOnce(env, applicant, 'medical', () => medicalNote(env, applicant.diagnosis), { fetchImpl, now })
    : 'skipped: no diagnosis';
  return { welcome, medical };
}

/** Is this account one the site's application form made? (that path posts its own intake) */
async function madeByForm(DB, accountId) {
  try {
    const row = await DB.prepare('SELECT id FROM applications WHERE jt_account_id = ?').bind(accountId).first();
    return !!row;
  } catch {
    return false; // no applications table yet
  }
}

const cleanStatus = (s) => {
  const v = String(s ?? '').trim();
  return v === 'null' || v === 'undefined' ? '' : v;
};

/**
 * One wake-up from the JobTread workflow. Never trusts the body beyond the
 * account id and the previous status (which only decides forward vs back).
 */
export async function handleApplicantEvent(env, payload, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { DB } = env;
  if (!DB || !env.JOBTREAD_GRANT_KEY) return { ok: false, error: 'not configured' };
  const accountId = String(payload?.accountId || '');
  if (!/^[A-Za-z0-9]{6,32}$/.test(accountId)) return { ok: false, error: 'bad accountId' };
  await ensureCommsSchema(DB);

  const actions = {};
  let error = null;
  let applicant = null;
  try {
    applicant = await readApplicant(env, accountId, fetchImpl);
    if (!applicant) {
      actions.skipped = 'not a SOARD customer account';
    } else {
      const fromForm = await madeByForm(DB, accountId);
      const newAccount = String(applicant.createdAt || '') >= INTAKE_SINCE;
      // Intake: the welcome once the account is Applied, the medical note once there's a diagnosis
      if (!fromForm && newAccount) {
        if (applicant.status === 'Applied') {
          Object.assign(actions, await sendIntake(env, applicant, { fetchImpl, now }));
        } else if (applicant.diagnosis) {
          actions.medical = await sendOnce(env, applicant, 'medical', () => medicalNote(env, applicant.diagnosis), { fetchImpl, now });
        }
      }
      // Status moves. JobTread sends nextStatus only when Status itself changed
      // (a Diagnosis edit arrives with both as "null"); without the field, compare.
      const previous = cleanStatus(payload?.previousStatus);
      const status = applicant.status;
      const statusChanged = payload?.nextStatus === undefined || cleanStatus(payload.nextStatus) !== '';
      if (statusChanged && status !== previous && status in RANK && previous in RANK) {
        const kind = KIND_FOR_STATUS[status];
        if (RANK[status] >= RANK[previous] && kind) {
          const parent = applicant.primary?.name || 'Hello';
          actions[kind] = await sendOnce(env, applicant, kind, () => familyMessage(env, kind, { parent, child: applicant.name }), { assign: true, fetchImpl, now });
        } else if (RANK[status] < RANK[previous] && status) {
          await postAccountComment(env, { accountId, message: `Moved back to ${status}` }, fetchImpl);
          actions.movedBack = status;
        }
      }
    }
  } catch (e) {
    error = e.message;
  }

  try {
    await DB.prepare(`INSERT INTO applicant_events (event_id, account_id, previous_status, status, actions, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(String(payload?.eventId || '').slice(0, 64) || null, accountId, cleanStatus(payload?.previousStatus) || null,
        applicant?.status || null, JSON.stringify(actions), error, new Date(now).toISOString()).run();
    await DB.prepare('DELETE FROM applicant_events WHERE id <= (SELECT MAX(id) - 500 FROM applicant_events)').run();
  } catch { /* the log is best effort */ }

  return error ? { ok: false, error, actions } : { ok: true, actions };
}

export async function recentEvents(DB, limit = 50) {
  await ensureCommsSchema(DB);
  const { results } = await DB.prepare('SELECT * FROM applicant_events ORDER BY id DESC LIMIT ?').bind(limit).all();
  return (results || []).map(r => ({ ...r, actions: (() => { try { return JSON.parse(r.actions || '{}'); } catch { return {}; } })() }));
}
