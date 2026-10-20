/**
 * GET /api/automations-admin (Cloudflare Access) — live facts for Site → Automations
 * ==========================================================================
 * The admin's automations map (public/admin/automations.js) describes every
 * automation and connection; this route tells it which ones are actually
 * switched on and when they last ran, so the map can't drift from reality:
 *
 *  - env:       which keys are set in Cloudflare (true/false only, never values)
 *  - bindings:  D1, R2, Workers AI, the live hub
 *  - broadcast: the Broadcast settings switches (outputs, reminders, Reels, Kit, messages)
 *  - health:    heartbeat, daily check, Stream webhook, replay check timestamps
 *  - hub:       the live hub's own status, and whether it runs the current code
 *  - invites:   reveal invite sending switch, the last safety sweep and guest check
 *  - revealChecks: weekday reveal checks switch and last run; date sync's last activity
 *  - liveSchedule: the live countdown's last JobTread check (what it follows, what's waiting)
 *  - kidStatus: kid statuses following JobTread (last sweep, last run, profiles it hid)
 *  - fbArchive: last Facebook replay rescue and replays still waiting for a kid
 *  - sends:     last reminder send per kind and channel (counts only)
 *  - jobtread:  SOARD workflows (on/off) and webhooks (host and events only)
 *
 * Not in _middleware's public list, so Access guards it. Never cached.
 * Each section fails on its own: one unreachable service never blanks the rest.
 */

import { hubStatus } from './_broadcast.js';
import { JT_URL, SOARD_ORG_ID } from './_reveals.js';

const has = (v) => typeof v === 'string' ? v.trim().length > 0 : !!v;

async function siteConfig(DB, key) {
  const row = await DB.prepare('SELECT data, updated_at FROM site_config WHERE key = ?').bind(key).first();
  if (!row) return null;
  try { return { data: JSON.parse(row.data), updatedAt: row.updated_at }; } catch { return null; }
}

export function envFacts(env) {
  return {
    slack: has(env.SLACK_WEBHOOK_URL),
    twilio: has(env.TWILIO_ACCOUNT_SID) && has(env.TWILIO_AUTH_TOKEN) && (has(env.TWILIO_FROM) || has(env.TWILIO_MESSAGING_SERVICE_SID)),
    youtube: has(env.YOUTUBE_API_KEY),
    kit: has(env.KIT_API_KEY),
    resend: has(env.RESEND_API_KEY),
    calendar: has(env.GOOGLE_CALENDAR_KEY),
    jobtread: has(env.JOBTREAD_GRANT_KEY),
    jobtreadQc: has(env.JOBTREAD_QC_GRANT_KEY),
    facebook: has(env.FB_PAGE_ID) && has(env.FB_PAGE_TOKEN),
    stream: has(env.CF_ACCOUNT_ID) && has(env.CF_STREAM_TOKEN),
    images: has(env.CF_ACCOUNT_ID) && has(env.CF_IMAGES_TOKEN),
    deployHook: has(env.CF_PAGES_DEPLOY_HOOK) || has(env.CF_DEPLOY_HOOK) || has(env.DEPLOY_HOOK_URL),
    github: has(env.GITHUB_TOKEN),
    access: has(env.CF_ACCESS_TEAM_DOMAIN) && has(env.CF_ACCESS_AUD),
    constantContact: has(env.CC_CLIENT_ID) || has(env.CC_CLIENT_SECRET) || has(env.CC_REFRESH_TOKEN),
    turnstile: has(env.TURNSTILE_SECRET_KEY),
    turnstileSite: has(env.TURNSTILE_SITE_KEY),
  };
}

/** The Broadcast settings, reduced to switches. Keys, stream URLs and secrets never leave. */
export function broadcastFacts(cfg) {
  if (!cfg) return null;
  const c = cfg.data || {};
  const out = (name) => (c.outputs?.[name] ? !!c.outputs[name].enabled : null);
  return {
    inputEnabled: c.liveInput ? c.liveInput.enabled !== false : null,
    outputs: { facebook: out('facebook'), youtube: out('youtube'), instagram: out('instagram') },
    facebookMode: c.facebook?.mode || null,
    reels: c.reels?.enabled !== false,
    reminders: { enabled: !!c.reminders?.enabled, sms: !!c.reminders?.sms, push: !!c.reminders?.push },
    kitLive: c.kitLive?.enabled !== false,
    messages: c.messages?.enabled !== false,
    vapid: !!c.vapid?.publicKey,
    alertCount: Array.isArray(c.alerts?.emails) ? c.alerts.emails.length : 0,
    updatedAt: cfg.updatedAt,
  };
}

export function healthFacts(h) {
  if (!h) return null;
  const d = h.data || {};
  return {
    lastTickAt: d.lastTick?.at || null,
    lastTickSource: d.lastTick?.source || null,
    lastDailyAt: d.lastDailyAt || null,
    hubOk: d.hub ? !!d.hub.ok : null,
    streamOk: d.stream ? !!d.stream.ok : null,
    facebookOk: d.facebook ? !!d.facebook.ok : null,
    webhookAt: d.webhook?.lastReceivedAt || null,
    webhookEvent: d.webhook?.lastEvent || null,
    replayCheckAt: d.replayCheckAt || null,
    monitorAt: d.monitor?.at || null,
  };
}

export function inviteFacts(cfg, rows, guestCheck = null) {
  if (!cfg) return null;
  const s = cfg.data?.lastSweep || {};
  return {
    enabled: !!cfg.data?.enabled,
    lastSweepAt: s.at || null,
    // The guest check's row holds when it's next due; updated_at is when it last ran
    lastGuestCheckAt: guestCheck?.updatedAt || null,
    checked: s.checked ?? null,
    changed: s.changed ?? null,
    errors: s.errors ?? null,
    rows: rows ?? null,
  };
}

/** Weekday reveal checks (site_config "reveal-nudges") and the date sync's last activity (reveal_sync) */
export function revealCheckFacts(cfg, sync) {
  const d = cfg?.data || {};
  const run = d.lastRun && !d.lastRun.running ? d.lastRun : null;
  return {
    enabled: !!d.enabled,
    lastRunAt: run?.at || null,
    checked: run?.checked ?? null,
    posted: run?.posted ?? null,
    repaired: run?.repaired ?? null,
    errors: run?.errors ?? null,
    lastErrorAt: d.lastError?.at || null,
    syncedAt: sync?.last || null,
    syncedJobs: sync?.n ?? null,
  };
}

/** The live countdown's last JobTread check (site_config "broadcast-schedule", _broadcast-schedule.js) */
export function liveScheduleFacts(rec) {
  const d = rec?.data;
  if (!d) return { checkedAt: null, error: null, next: null, waiting: 0 };
  const n = d.next;
  return {
    checkedAt: d.checkedAt || null,
    error: d.error || null,
    next: n ? `${n.name || 'the next reveal'} on ${n.date}${n.time ? ` at ${n.time}` : ''}` : null,
    waiting: (d.waiting || []).length,
  };
}

/** Kid status from JobTread (kid_status_state, _kid-status.js); hidden: profiles JobTread took off the site */
export function kidStatusFacts(state, hidden = null) {
  const d = state || {};
  return {
    lastSweepAt: d.lastSweepAt || null,
    lastRunAt: d.lastRun?.at || null,
    changed: d.lastRun?.changed ?? null,
    deployPending: !!d.deployPending,
    lastAutoDeployAt: d.lastAutoDeployAt || null,
    hidden,
  };
}

/** placed: Stream uids some kid page already uses (staff can attach a replay by hand in the kid editor) */
export function archiveFacts(a, placed = new Set()) {
  if (!a) return null;
  const items = Object.values(a.data?.archived || {});
  return {
    checkedAt: a.data?.checkedAt || null,
    archived: items.length,
    needsKid: items.filter((x) => x.needsKid && !x.attachedTo && !placed.has(x.uid)).length,
    lastAutoDeployAt: a.data?.lastAutoDeployAt || null,
  };
}

// Which of the archive's unplaced replays already sit on a kid page
async function placedUids(DB, archive) {
  const waiting = Object.values(archive?.data?.archived || {}).filter((x) => x.needsKid && !x.attachedTo && x.uid);
  const placed = new Set();
  for (const x of waiting) {
    const hit = await DB.prepare('SELECT 1 AS hit FROM kids WHERE instr(data, ?) > 0 LIMIT 1').bind(x.uid).first('hit');
    if (hit) placed.add(x.uid);
  }
  return placed;
}

/** SOARD's JobTread workflows and webhooks. Webhook URLs carry tokens, so only host and path start leave.
 *  Two queries, so a grant that can read workflows but not webhooks still reports the workflows. */
export async function jobtreadFacts(grantKey, fetchImpl = fetch) {
  if (!grantKey) return { error: 'JOBTREAD_GRANT_KEY is not set' };
  const ask = async (field) => {
    const res = await fetchImpl(JT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { $: { grantKey }, organization: { $: { id: SOARD_ORG_ID }, ...field } } }),
    });
    if (!res.ok) throw new Error(`JobTread returned ${res.status}`);
    const conn = Object.values((await res.json().catch(() => null))?.organization || {})[0];
    if (!conn?.nodes) throw new Error('JobTread did not answer');
    return conn.nodes;
  };
  const [wfs, hooks] = await Promise.allSettled([
    ask({ workflows: { $: { size: 100 }, nodes: { id: {}, name: {}, isActive: {} } } }),
    ask({ webhooks: { $: { size: 100 }, nodes: { id: {}, url: {}, eventTypes: {} } } }),
  ]);
  if (wfs.status === 'rejected' && hooks.status === 'rejected') return { error: wfs.reason.message };
  const out = {};
  if (wfs.status === 'fulfilled') {
    out.workflows = {};
    for (const w of wfs.value) out.workflows[w.id] = { name: w.name, active: !!w.isActive };
  }
  if (hooks.status === 'fulfilled') {
    out.webhooks = {};
    for (const h of hooks.value) {
      let where = '';
      try { const u = new URL(h.url); where = u.host + u.pathname.split('/').slice(0, 3).join('/'); } catch {}
      out.webhooks[h.id] = { where, events: h.eventTypes || [] };
    }
  }
  return out;
}

const settle = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };

export async function gatherFacts(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const DB = env.DB;
  const [cfg, health, invites, archive, reveals, inviteRows, sends, reminders, hub, jobtread, checks, synced, liveSchedule, guestCheck, kidState, kidsHidden] = await Promise.all([
    settle(() => siteConfig(DB, 'broadcast-config')),
    settle(() => siteConfig(DB, 'broadcast-health')),
    settle(() => siteConfig(DB, 'reveal-invites')),
    settle(() => siteConfig(DB, 'fb-archive')),
    settle(() => DB.prepare("SELECT updated_at FROM site_config WHERE key = 'reveals'").first('updated_at')),
    settle(() => DB.prepare('SELECT count(*) AS n FROM reveal_invites').first('n')),
    settle(() => DB.prepare('SELECT kind, channel, max(created_at) AS last, sum(sent) AS sent, sum(failed) AS failed FROM broadcast_sends GROUP BY kind, channel').all()),
    settle(() => DB.prepare('SELECT count(*) AS n FROM broadcast_reminders').first('n')),
    settle(() => hubStatus(env)),
    settle(() => jobtreadFacts(env.JOBTREAD_GRANT_KEY, fetchImpl)),
    settle(() => siteConfig(DB, 'reveal-nudges')),
    // The table appears with the first sync; until then this settles to an error
    settle(() => DB.prepare('SELECT count(*) AS n, max(updated_at) AS last FROM reveal_sync').first()),
    settle(() => siteConfig(DB, 'broadcast-schedule')),
    settle(() => siteConfig(DB, 'reveal-invites-guest-check')),
    // The table appears with the first kid status sync; until then this settles to an error
    settle(async () => JSON.parse((await DB.prepare("SELECT value FROM kid_status_state WHERE key = 'state'").first('value')) || '{}')),
    settle(() => DB.prepare(`SELECT count(*) AS n FROM kids WHERE instr(data, '"hiddenBy":"jobtread"') > 0`).first('n')),
  ]);
  const ok = (v) => (v && !v.error ? v : null);
  const sendMap = {};
  for (const r of ok(sends)?.results || []) {
    sendMap[r.kind] ||= {};
    sendMap[r.kind][r.channel] = { last: r.last, sent: r.sent || 0, failed: r.failed || 0 };
  }
  return {
    checkedAt: new Date(now).toISOString(),
    env: envFacts(env),
    bindings: { db: !!env.DB, files: !!env.FILES, ai: !!env.AI, hub: !!env.LIVE_HUB },
    broadcast: broadcastFacts(ok(cfg)),
    health: healthFacts(ok(health)),
    hub: hub?.error && !hub.bound
      ? { ok: false, error: hub.error }
      // The hub gained viewer counting with the watch party; older code reports no "watchers"
      : { ok: !!hub?.ok && !hub?.error, current: !!hub && 'watchers' in hub, lastTickAt: hub?.lastTick?.at || null, clients: hub?.clients ?? null, error: hub?.error || null },
    invites: inviteFacts(ok(invites), typeof inviteRows === 'number' ? inviteRows : null, ok(guestCheck)),
    revealChecks: revealCheckFacts(ok(checks), ok(synced)),
    liveSchedule: liveScheduleFacts(ok(liveSchedule)),
    kidStatus: kidStatusFacts(ok(kidState), typeof kidsHidden === 'number' ? kidsHidden : null),
    fbArchive: archiveFacts(ok(archive), await settle(() => placedUids(DB, ok(archive))).then((p) => (p instanceof Set ? p : new Set()))),
    reveals: { cachedAt: typeof reveals === 'string' ? reveals : null },
    sends: sendMap,
    reminders: { subscribers: typeof reminders === 'number' ? reminders : null },
    jobtread: jobtread || { error: 'JobTread check failed' },
  };
}

export async function onRequestGet(context) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    return Response.json({ success: true, ...(await gatherFacts(context.env)) }, { headers });
  } catch (err) {
    // 500, not 502: Cloudflare replaces 502 bodies with its own error page
    return Response.json({ success: false, error: err.message }, { status: 500, headers });
  }
}
