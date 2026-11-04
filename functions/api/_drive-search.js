/**
 * SOARD's Google Drive, read-only: a founder searches every staff account's
 * Drive at once (what each person owns or can open) and opens a file.
 * ===========================================================================
 * Like the mailbox reader (./_mailbox.js): founders on People → Team only, only
 * active soardcharity.com accounts, the site's domain-wide delegation with
 * Drive's read-only scope, nothing stored, and every search and open logged.
 */

import { accessToken } from './_google-calendar.js';
import { canRead, mailboxes, resolveMailbox } from './_mailbox.js';
import { logAudit } from './_audit.js';

export const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const AT_ONCE = 6;
const MAX_Q = 200;
const MAX_FILE = 25 * 1024 * 1024;
const FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const FIELDS = 'files(id,name,mimeType,size,modifiedTime,createdTime,owners(emailAddress,displayName))';

export { canRead };
const fail = (status, message) => Object.assign(new Error(message), { status });
/** Drive's query language quotes with ', escaping \ and ' */
const quoted = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function drive(token, path, fetchImpl, { raw = false } = {}) {
  const res = await fetchImpl(`${DRIVE}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) });
  if (raw) {
    if (!res.ok) throw fail(res.status === 404 ? 404 : 500, `Google Drive answered ${res.status}`);
    return res;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw fail(res.status === 404 ? 404 : 500, `Google Drive answered ${res.status}: ${body?.error?.message || ''}`.trim());
  return body;
}

async function tokenFor(env, email, fetchImpl, now) {
  try {
    return await accessToken(env, email, { fetchImpl, now, scope: DRIVE_READ_SCOPE });
  } catch (err) {
    throw fail(500, /unauthorized_client/.test(err.message)
      ? 'Google hasn’t given the site Drive read access: Google Admin → Security → API controls → Domain-wide delegation needs drive.readonly on the site’s client'
      : err.message);
  }
}

async function audit(env, me, what) {
  await logAudit(env.DB, { userEmail: me, action: 'viewed', entityType: 'mailbox', entitySlug: 'drive', entityName: `Drive: ${what}`.slice(0, 240), gitStatus: 'ok' }).catch(() => {});
}

/**
 * Search everyone's Drive (or one account's) by words in a file's name or text.
 * images: only pictures. → { q, files: [{ account, id, name, mimeType, size, modifiedTime, owner }], problems }
 */
export async function searchDrive(env, { me, q, account = '', images = false, fetchImpl = fetch, now = Date.now() }) {
  const words = String(q || '').trim().slice(0, MAX_Q);
  if (!words) throw fail(400, 'Type what to look for');
  const accounts = account ? [await resolveMailbox(env, account)] : await mailboxes(env);
  const query = `(name contains ${quoted(words)} or fullText contains ${quoted(words)}) and trashed = false${images ? " and mimeType contains 'image/'" : ''}`;
  const seen = new Set();
  const files = [];
  const problems = [];
  for (let i = 0; i < accounts.length; i += AT_ONCE) {
    await Promise.all(accounts.slice(i, i + AT_ONCE).map(async (a) => {
      try {
        const token = await tokenFor(env, a.email, fetchImpl, now);
        const got = await drive(token, `/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(FIELDS)}&pageSize=50&corpora=user&orderBy=modifiedTime desc`, fetchImpl);
        for (const f of got.files || []) {
          if (seen.has(f.id)) continue; // shared with several people: listed once, under whoever found it first
          seen.add(f.id);
          files.push({ account: a.email, id: f.id, name: f.name, mimeType: f.mimeType, size: Number(f.size) || null, modifiedTime: f.modifiedTime, owner: f.owners?.[0]?.emailAddress || null });
        }
      } catch (err) {
        problems.push({ account: a.email, error: err.message });
      }
    }));
  }
  files.sort((x, y) => String(y.modifiedTime).localeCompare(String(x.modifiedTime)));
  await audit(env, me, `searched ${account ? account : 'every account'} for “${words.slice(0, 120)}”${images ? ' (pictures)' : ''}`);
  return { q: words, files, problems };
}

/** One file's bytes, as the account that found it → { name, type, bytes } */
export async function readDriveFile(env, { me, account, id, fetchImpl = fetch, now = Date.now() }) {
  if (!FILE_ID.test(String(id || ''))) throw fail(400, 'That isn’t a Drive file’s id');
  const box = await resolveMailbox(env, account);
  const token = await tokenFor(env, box.email, fetchImpl, now);
  const meta = await drive(token, `/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size`, fetchImpl);
  if (/^application\/vnd\.google-apps\./.test(meta.mimeType || '')) throw fail(400, 'A Google Doc, Sheet or Slides file opens in Google Drive, not here');
  if (Number(meta.size) > MAX_FILE) throw fail(413, 'That file is over 25 MB; open it in Google Drive');
  const res = await drive(token, `/files/${encodeURIComponent(id)}?alt=media`, fetchImpl, { raw: true });
  const bytes = new Uint8Array(await res.arrayBuffer());
  await audit(env, me, `opened ${meta.name} (${box.email})`);
  return { name: meta.name, type: meta.mimeType || '', bytes };
}
