/**
 * POST /api/save-content
 * Updates D1 (source of truth for builds) THEN commits to GitHub (VCS backup).
 * D1 is what the prebuild script reads — it must always have the latest data.
 * GitHub failures are logged but don't block the save.
 *
 * Expects JSON body:
 *   {
 *     path: "src/content/kids/amari.json",
 *     content: "{ ... }",        // file content as JSON string
 *     message: "Update amari",   // used as git commit message
 *     sha: "..."                 // the version it was read at: changed since → 409
 *     create: true               // a new record: one already at that path (added meanwhile) → 409, never overwritten
 *   }
 *
 * Env bindings: DB (D1)
 * Env vars: GITHUB_TOKEN, GITHUB_REPO (required for git commits)
 *           GITHUB_BRANCH (optional, default "main")
 */

import { EXTRACTORS, parsePath, generateSha, scriptLinks, linkScheme } from './_collections.js';
import { commitFile } from './_github.js';
import { logAudit, diffJson, getEntityName } from './_audit.js';
import { refreshForBoardChange } from './_reveal-invites.js';
import { getsRevealInvites } from './_team.js';
import { HISTORY_TABLES, SITE_COLLECTION, recordVersion as recordContentVersion } from './_content-history.js';
import { coverOf } from './_job-covers.js';
import { syncCoverForKid } from './_kid-status.js';
import { recheckWaiting } from './_kid-partners.js';
import { wakeRevealDesigns } from './_reveal-design-auto.js';
import { keepGiftsForPartnerName } from './_donor-crm.js';

export async function onRequestPost(context) {
  try {
    const { DB } = context.env;
    const userEmail = context.data?.userEmail || 'unknown';
    const { path, content, message, sha: clientSha, create = false } = await context.request.json();

    if (!path || content === undefined || !message) {
      return Response.json(
        { success: false, error: 'Missing required fields: path, content, message' },
        { status: 400 }
      );
    }

    const parsed = parsePath(path);
    if (!parsed) {
      return Response.json(
        { success: false, error: 'Path not allowed' },
        { status: 403 }
      );
    }

    let data = typeof content === 'string' ? JSON.parse(content) : content;
    // A link that runs script when clicked (javascript:, data:, vbscript:) never
    // reaches the site or the public repo, whatever screen sent it
    const scripted = scriptLinks(data);
    if (scripted.length) {
      return Response.json(
        { success: false, error: `That link can’t be saved: ${scripted[0].path} must be a web address starting with https:// (not ${linkScheme(scripted[0].value)}:)`, fields: scripted.map((s) => s.path) },
        { status: 400 }
      );
    }
    let jsonStr = JSON.stringify(data);
    let prettyJson = JSON.stringify(data, null, 2);
    const now = new Date().toISOString();

    // 0. Read old value for diffing + optimistic-concurrency check
    let oldData = null;
    let oldRaw = null;
    let isCreate = true;
    try {
      if (parsed.type === 'site') {
        const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(parsed.key).first();
        if (row) { oldRaw = row.data; oldData = JSON.parse(row.data); isCreate = false; }
      } else {
        const row = await DB.prepare(`SELECT data FROM ${parsed.table} WHERE slug = ?`).bind(parsed.slug).first();
        if (row) { oldRaw = row.data; oldData = JSON.parse(row.data); isCreate = false; }
      }
    } catch (e) { /* first save — no old data */ }

    // Optimistic concurrency: if the client sent the sha it loaded and the row
    // still exists, reject when the stored content changed since. The client's
    // sha comes from read-content, which hashes the stored JSON string with
    // generateSha() — so compare against generateSha(oldRaw). No sha, or no
    // existing row (a create) → proceed as before.
    // Adding a new record where one is already (another tab, a teammate, a list read before it was added): never
    // overwrites it
    if (create === true && oldRaw !== null) {
      // The very record it would add (this save sent again after its answer was lost): done already
      if (oldRaw === jsonStr) return Response.json({ success: true, sha: await generateSha(oldRaw), same: true });
      return Response.json({ success: false, error: 'There’s one at that address already: someone added it since this list was read. Nothing was changed.' }, { status: 409 });
    }
    // A person loaded with a sha whose row is gone was renamed or deleted
    // meanwhile: saving would bring the old record back as a duplicate
    if (clientSha && oldRaw === null && parsed.table === 'team') {
      return Response.json(
        { success: false, error: 'This person was renamed or deleted since you opened them. Go back to the list to open their current record.' },
        { status: 409 }
      );
    }

    // A new person at an address a former board member's board records are kept under (their signatures, sign-ins,
    // signing record): never someone else's (rename-content.js refuses renaming to one the same way)
    if (isCreate && parsed.table === 'team') {
      for (const t of ['board_signatures', 'board_signins', 'board_activity', 'board_sign_events']) {
        const had = await DB.prepare(`SELECT slug FROM ${t} WHERE slug = ? LIMIT 1`).bind(parsed.slug).first().catch(() => null);
        if (had) return Response.json({ success: false, error: `“${parsed.slug}” was a former board member’s address, and their board records are kept under it. Give this person another address.` }, { status: 409 });
      }
    }

    if (clientSha && oldRaw !== null) {
      const currentSha = await generateSha(oldRaw);
      if (currentSha !== clientSha) {
        return Response.json(
          { success: false, error: 'Conflict: this item was changed since you loaded it. Reload to get the latest version.' },
          { status: 409 }
        );
      }
    }

    // Who designed a room and who paid for it are room credits (./_room-credits.js): picked in JobTread or on their
    // card in Admin → Kids, never by a page save, so a tab opened before a credit changed can't put it back
    if (!isCreate && (parsed.table === 'kids' || parsed.table === 'community')) {
      const kept = (k) => (Array.isArray(oldData?.[k]) ? oldData[k] : []);
      const same = (k) => JSON.stringify(kept(k)) === JSON.stringify(Array.isArray(data[k]) ? data[k] : []);
      if (!same('designers') || !same('sponsors')) {
        data = { ...data, designers: kept('designers'), sponsors: kept('sponsors') };
        jsonStr = JSON.stringify(data);
        prettyJson = JSON.stringify(data, null, 2);
      }
    }

    // A partner card added or renamed: the gifts Donors & Partners counted for a name by itself stay where they count
    // (written first: if the save is then refused, they're only linked where they counted already)
    if (parsed.table === 'partners' && (data?.name || parsed.slug) !== (oldData?.name || (oldData ? parsed.slug : null))) {
      await keepGiftsForPartnerName(DB, { slug: parsed.slug, name: data?.name, by: userEmail, now: Date.parse(now) });
    }

    // 1. Write to D1 FIRST (source of truth — prebuild reads from D1, not GitHub)
    if (parsed.type === 'site') {
      await DB.prepare(
        'INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)'
      ).bind(parsed.key, jsonStr, now).run();
    } else {
      const { table, slug } = parsed;
      const extractor = EXTRACTORS[table];

      // A create (create: true) is a plain INSERT: two at one address at the same moment, the second is refused by the
      // database itself, never written over the first
      const verb = create === true ? 'INSERT' : 'INSERT OR REPLACE';
      const taken = (e) => { if (create === true && /UNIQUE constraint/i.test(String(e?.message || e))) throw Object.assign(new Error('There’s one at that address already: someone added it a moment ago. Nothing was changed.'), { status: 409 }); throw e; };
      if (extractor && !isCreate) {
        // Written only if the stored record is still the one read above: a sync or a credit card landing between
        // that read and this write isn't overwritten (the editor is told to reload instead)
        const [colNames, colValues] = extractor(data);
        const sets = ['"data" = ?', '"updated_at" = ?', ...colNames.map((c) => `${c} = ?`)];
        const r = await DB.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE slug = ? AND data = ?`).bind(jsonStr, now, ...colValues, slug, oldRaw).run();
        if (!r?.meta?.changes) {
          return Response.json({ success: false, error: 'Conflict: this item was changed since you loaded it. Reload to get the latest version.' }, { status: 409 });
        }
      } else if (extractor) {
        const [colNames, colValues] = extractor(data);
        const allCols = ['"slug"', '"data"', '"updated_at"', ...colNames];
        const placeholders = allCols.map(() => '?').join(', ');
        const allValues = [slug, jsonStr, now, ...colValues];

        await DB.prepare(
          `${verb} INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders})`
        ).bind(...allValues).run().catch(taken);
      } else {
        await DB.prepare(
          `${verb} INTO ${table} (slug, data, updated_at) VALUES (?, ?, ?)`
        ).bind(slug, jsonStr, now).run().catch(taken);
      }
    }

    const sha = await generateSha(jsonStr);

    // 2. Commit to GitHub (VCS backup). Non-blocking — D1 already has the data.
    let gitStatus = 'ok';
    try {
      await commitFile(context.env, path, prettyJson + '\n', message);
    } catch (err) {
      gitStatus = 'failed';
      console.error('[save-content] GitHub commit failed:', err.message);
    }

    // 3. Audit log
    const entityType = parsed.type === 'site' ? parsed.key : parsed.table;
    const entitySlug = parsed.type === 'site' ? parsed.key : parsed.slug;
    const action = isCreate ? 'created' : (data.publishStatus === 'draft' ? 'drafted' : 'updated');

    await logAudit(DB, {
      userEmail,
      action,
      entityType,
      entitySlug,
      // A save through the SOARD connection for Claude says so (./_mcp/pages.js)
      entityName: `${getEntityName(data, entityType) || ''}${context.data?.via || ''}` || null,
      changes: isCreate ? null : diffJson(oldData, data),
      path,
      gitStatus,
    });

    // Every saved version is kept, so the editors can show history and restore
    const historyOf = parsed.type === 'site' ? { collection: SITE_COLLECTION, slug: parsed.key } : HISTORY_TABLES[parsed.table] ? { collection: parsed.table, slug: parsed.slug } : null;
    if (historyOf) {
      try { await recordContentVersion(DB, { ...historyOf, data, previous: oldData, userEmail, now }); }
      catch (e) { console.error(`[save-content] ${historyOf.collection} history:`, e.message); }
    }

    // Joining or leaving the board changes who confirmed reveal invites reach: follow it now
    if (parsed.table === 'team' && getsRevealInvites(oldData) !== getsRevealInvites(data)) context.waitUntil(refreshForBoardChange(context.env));
    // A kid's (or community project's) best photo is their JobTread job's cover: new photos go up now, not at the hourly sync
    if ((parsed.table === 'kids' || parsed.table === 'community') && coverOf(data) && coverOf(oldData)?.source !== coverOf(data).source) {
      context.waitUntil(syncCoverForKid(context.env, parsed.slug, { collection: parsed.table }));
    }
    // A logo added in Partners (or on a page) reaches the pages waiting for it now, not at the next 10-minute check
    const logoFacts = (d) => (parsed.table === 'partners' ? [d?.logo, d?.name, d?.website] : d?.partnerLogos || []);
    if (['partners', 'kids', 'community'].includes(parsed.table) && JSON.stringify(logoFacts(data)) !== JSON.stringify(logoFacts(oldData))) context.waitUntil(recheckWaiting(context.env));
    // Before photos nobody has looked at yet (brought in with Bring in from JobTread): the site looks at them now, not at
    // its next 10-minute run, and they stay off the page until it has (./_reveal-design-auto.js, ./_photo-screen.js)
    const unlooked = (d) => (d?.beforePhotos || []).filter((p) => p?.url && !p.looked).map((p) => p.url).join('\n');
    if (parsed.table === 'kids' && unlooked(data) && unlooked(data) !== unlooked(oldData)) context.waitUntil(wakeRevealDesigns(context.env));

    return Response.json({
      success: true,
      sha,
      path,
      gitCommit: gitStatus,
    });
  } catch (err) {
    if (err.status === 409) return Response.json({ success: false, error: err.message }, { status: 409 });
    console.error("[save-content]", err);
    return Response.json(
      { success: false, error: err.message || "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
