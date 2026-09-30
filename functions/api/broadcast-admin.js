/**
 * /api/broadcast-admin — control center data + setup actions (Access only)
 * =========================================================================
 * GET  ?reveal=1  include ingest secrets + Larix setup links (for the QR codes)
 *      ?fb=1      also query Facebook's recent broadcasts (costs Graph quota)
 * POST { action }:
 *   setupInput | refreshInput | rotateKeys | enableInput | disableInput
 *   setupRehearsal | deleteRehearsal
 *   setOutput { target: facebook|youtube, url, streamKey } | toggleOutput { target, enabled } | removeOutput { target }
 *   setConfig { ...partial }
 *   generateVapid { force? }
 *   testStream | testFacebook | testHub | testAlert | runTick | lifecycle
 *   sendTestReminder { kind, email }
 *   createNotificationInstructions
 */

import * as b from './_broadcast.js';
import * as stream from './_stream-live.js';
import * as notify from './_broadcast-notify.js';
import * as fb from './_broadcast-fb.js';
import { kitConfigured } from './_kit.js';
import { logAudit } from './_audit.js';
import { annotateArchived } from './_fb-archive.js';

const TARGETS = new Set(['facebook', 'youtube', 'custom']);

function redactConfig(config, reveal) {
  const c = JSON.parse(JSON.stringify(config));
  if (c.vapid) c.vapid = { publicKey: c.vapid.publicKey, createdAt: c.vapid.createdAt };
  if (!reveal) {
    c.liveInput = stream.redactInput(c.liveInput);
    c.rehearsalInput = stream.redactInput(c.rehearsalInput);
  }
  return c;
}

function larixLinks(config) {
  const out = {};
  if (config.liveInput?.srt) {
    out.standard = stream.larixSetupLink(config.liveInput, { name: 'SOARD Live', profile: 'standard' });
    out.lowSignal = stream.larixSetupLink(config.liveInput, { name: 'SOARD Live (weak signal)', profile: 'lowSignal' });
    out.srtUrl = stream.srtUrl(config.liveInput);
    out.rtmps = config.liveInput.rtmps || null;
  }
  if (config.rehearsalInput?.srt) {
    out.rehearsal = stream.larixSetupLink(config.rehearsalInput, { name: 'SOARD Rehearsal', profile: 'standard' });
    out.rehearsalSrtUrl = stream.srtUrl(config.rehearsalInput);
  }
  return out;
}

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const reveal = url.searchParams.get('reveal') === '1';
  const withFb = url.searchParams.get('fb') === '1';
  try {
    await b.ensureSchema(env.DB);
    const [config, state, health] = await Promise.all([b.readConfig(env.DB), b.readState(env.DB), b.readHealth(env.DB)]);
    const DB = env.DB;

    const tasks = {
      hub: b.hubStatus(env),
      lifecycle: config.liveInput?.uid ? stream.lifecycle(config.customerCode, config.liveInput.uid) : Promise.resolve(null),
      rehearsalLifecycle: config.rehearsalInput?.uid ? stream.lifecycle(config.customerCode, config.rehearsalInput.uid) : Promise.resolve(null),
      viewers: config.liveInput?.uid ? stream.liveViewers(config.customerCode, config.liveInput.uid) : Promise.resolve(null),
      outputs: (config.liveInput?.uid && stream.streamConfigured(env)) ? stream.listOutputs(env, config.liveInput.uid).catch(() => null) : Promise.resolve(null),
      recordings: (config.liveInput?.uid && stream.streamConfigured(env)) ? stream.listInputVideos(env, config.liveInput.uid).catch(() => null) : Promise.resolve(null),
      reminderCounts: DB.prepare(`SELECT channel, COUNT(*) AS n FROM broadcast_reminders WHERE unsubscribed_at IS NULL GROUP BY channel`).all(),
      recentReminders: DB.prepare(`SELECT channel, address, kid_slug, created_at, source FROM broadcast_reminders WHERE unsubscribed_at IS NULL ORDER BY created_at DESC LIMIT 10`).all(),
      sends: state.broadcastId ? DB.prepare(`SELECT kind, channel, recipients, sent, failed, error, created_at FROM broadcast_sends WHERE broadcast_id = ? ORDER BY created_at`).bind(state.broadcastId).all() : Promise.resolve(null),
      history: DB.prepare(`SELECT id, kid_slug, kid_name, title, scheduled_at, live_at, ended_at, phase, replay_uid, fb_permalink, source, data, created_at FROM broadcasts ORDER BY created_at DESC LIMIT 12`).all(),
      events: DB.prepare(`SELECT broadcast_id, type, COUNT(*) AS n FROM broadcast_events WHERE broadcast_id IN (SELECT id FROM broadcasts ORDER BY created_at DESC LIMIT 12) GROUP BY broadcast_id, type`).all(),
      fbRecent: withFb ? fb.fbRecentBroadcasts(env, 5) : Promise.resolve(null),
    };
    const keys = Object.keys(tasks);
    const settled = await Promise.allSettled(keys.map(k => tasks[k]));
    const r = {};
    keys.forEach((k, i) => { r[k] = settled[i].status === 'fulfilled' ? settled[i].value : null; });
    // Which saved replay sits on which kid page (drives the kid picker under History)
    if (r.fbRecent?.videos?.length) r.fbRecent = { ...r.fbRecent, videos: await annotateArchived(DB, r.fbRecent.videos) };

    const outputsCfg = config.outputs || {};
    const liveOutputs = r.outputs?.result || [];
    const outputs = Object.entries(outputsCfg).map(([target, o]) => {
      const live = liveOutputs.find(x => x.uid === o.uid);
      return { target, ...o, exists: !!live, enabled: live ? live.enabled !== false : o.enabled, streamUrl: live?.url || o.url };
    });

    const recordings = (r.recordings?.result || []).slice(0, 8).map(v => ({
      uid: v.uid, name: v.meta?.name || null, created: v.created, duration: v.duration || null,
      state: v.status?.state || null, readyToStream: !!v.readyToStream,
      thumbnail: stream.thumbnailUrl(config.customerCode, v.uid, { width: 320, height: 180 }),
      watch: stream.watchUrl(v.uid),
      isCurrentReplay: v.uid === state.replayUid,
      isLiveNow: v.status?.state === 'live-inprogress',
    }));

    const counts = {};
    for (const row of (r.reminderCounts?.results || [])) counts[row.channel] = row.n;
    const eventsByBroadcast = {};
    for (const row of (r.events?.results || [])) { (eventsByBroadcast[row.broadcast_id] ||= {})[row.type] = row.n; }
    const history = (r.history?.results || []).map(h => { let d = {}; try { d = JSON.parse(h.data || '{}'); } catch {} return { ...h, data: d, events: eventsByBroadcast[h.id] || {} }; });

    return Response.json({
      success: true,
      state,
      public: b.publicState(state, config),
      legacy: b.legacyState(state, config),
      config: redactConfig(config, reveal),
      larix: reveal ? larixLinks(config) : null,
      setup: {
        streamConfigured: stream.streamConfigured(env),
        fbConfigured: fb.fbConfigured(env),
        emailConfigured: notify.emailConfigured(env),
        smsConfigured: notify.smsConfigured(env),
        slackConfigured: notify.slackConfigured(env),
        kitConfigured: kitConfigured(env),
        hubBound: !!env.LIVE_HUB,
        deployHook: !!(env.CF_PAGES_DEPLOY_HOOK || env.CF_DEPLOY_HOOK || env.DEPLOY_HOOK_URL),
        inputReady: !!config.liveInput?.uid,
        pushReady: !!config.vapid?.publicKey,
        webhookUrl: `${b.SITE_ORIGIN}/api/stream-webhook`,
        alertEmails: notify.alertEmails(env, config),
      },
      health,
      hub: r.hub,
      live: { lifecycle: r.lifecycle, rehearsal: r.rehearsalLifecycle, viewers: r.viewers },
      outputs,
      recordings,
      reminders: {
        counts,
        recent: (r.recentReminders?.results || []).map(x => ({ ...x, address: maskAddress(x.channel, x.address) })),
      },
      sends: r.sends?.results || [],
      history,
      fbRecent: r.fbRecent,
      playback: {
        customerCode: config.customerCode,
        liveEmbed: config.liveInput?.uid ? stream.embedUrl(config.customerCode, config.liveInput.uid, { muted: true, autoplay: true }) : null,
        rehearsalEmbed: config.rehearsalInput?.uid ? stream.embedUrl(config.customerCode, config.rehearsalInput.uid, { muted: true, autoplay: true }) : null,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}

function maskAddress(channel, address) {
  if (!address) return '';
  if (channel === 'email') { const [u, d] = address.split('@'); return `${u.slice(0, 2)}…@${d || ''}`; }
  if (channel === 'sms') return `${address.slice(0, 5)}…${address.slice(-2)}`;
  try { return new URL(address).host; } catch { return 'push'; }
}

async function storeInput(env, config, key, record) {
  config[key] = record;
  await b.writeConfig(env.DB, config);
}

export async function onRequestPost(context) {
  const { env } = context;
  const userEmail = context.data?.userEmail || 'unknown';
  let body = {};
  try { body = await context.request.json(); } catch { /* empty */ }
  const action = body.action;
  const fail = (error, status = 400) => Response.json({ success: false, error }, { status });

  try {
    await b.ensureSchema(env.DB);
    const config = await b.readConfig(env.DB);

    switch (action) {
      case 'setupInput': {
        if (!stream.streamConfigured(env)) return fail('CF_STREAM_TOKEN / CF_ACCOUNT_ID are not set in Cloudflare Pages');
        if (config.liveInput?.uid && !body.force) return fail('A live input already exists. Use Rotate keys, or pass force to replace it.');
        const r = await stream.createLiveInput(env, { name: body.name || 'SOARD reveals', timeoutSeconds: 30, lowLatency: true });
        if (!r.ok) return fail(`Stream: ${stream.errorMessage(r)}`, 500);
        await storeInput(env, config, 'liveInput', r.result);
        if (!config.setupAt) { config.setupAt = new Date().toISOString(); config.setupBy = userEmail; await b.writeConfig(env.DB, config); }
        await logAudit(env.DB, { userEmail, action: 'created', entityType: 'live-input', entitySlug: r.result.uid, entityName: 'Stream live input created', gitStatus: 'ok' });
        return Response.json({ success: true, input: stream.redactInput(r.result) });
      }
      case 'refreshInput': {
        if (!config.liveInput?.uid) return fail('No live input yet');
        const r = await stream.getLiveInput(env, config.liveInput.uid);
        if (!r.ok) return fail(`Stream: ${stream.errorMessage(r)}`, 500);
        await storeInput(env, config, 'liveInput', r.result);
        return Response.json({ success: true, input: stream.redactInput(r.result) });
      }
      case 'rotateKeys': {
        if (!config.liveInput?.uid) return fail('No live input yet');
        const r = await stream.rotateLiveInputKeys(env, config.liveInput.uid);
        if (!r.ok) return fail(`Stream: ${stream.errorMessage(r)}`, 500);
        // Some responses return the refreshed record; otherwise re-fetch
        const fresh = r.result?.srt ? r.result : (await stream.getLiveInput(env, config.liveInput.uid)).result;
        await storeInput(env, config, 'liveInput', fresh || config.liveInput);
        await logAudit(env.DB, { userEmail, action: 'updated', entityType: 'live-input', entitySlug: config.liveInput.uid, entityName: 'Stream ingest keys rotated', gitStatus: 'ok' });
        return Response.json({ success: true, input: stream.redactInput(fresh) });
      }
      case 'enableInput':
      case 'disableInput': {
        if (!config.liveInput?.uid) return fail('No live input yet');
        const r = await stream.updateLiveInput(env, config.liveInput.uid, { enabled: action === 'enableInput' });
        if (!r.ok) return fail(`Stream: ${stream.errorMessage(r)}`, 500);
        await storeInput(env, config, 'liveInput', { ...config.liveInput, enabled: action === 'enableInput' });
        return Response.json({ success: true });
      }
      case 'setupRehearsal': {
        if (!stream.streamConfigured(env)) return fail('Stream not configured');
        if (config.rehearsalInput?.uid) return fail('Rehearsal input already exists');
        const r = await stream.createLiveInput(env, { name: 'SOARD rehearsal (private)', timeoutSeconds: 10, lowLatency: true, deleteRecordingAfterDays: 30 });
        if (!r.ok) return fail(`Stream: ${stream.errorMessage(r)}`, 500);
        await storeInput(env, config, 'rehearsalInput', r.result);
        return Response.json({ success: true, input: stream.redactInput(r.result) });
      }
      case 'deleteRehearsal': {
        if (!config.rehearsalInput?.uid) return fail('No rehearsal input');
        await stream.deleteLiveInput(env, config.rehearsalInput.uid).catch(() => {});
        await storeInput(env, config, 'rehearsalInput', null);
        return Response.json({ success: true });
      }
      case 'setOutput': {
        const target = String(body.target || '').toLowerCase();
        if (!TARGETS.has(target)) return fail('target must be facebook, youtube or custom');
        if (!config.liveInput?.uid) return fail('Create the live input first');
        const url = String(body.url || stream.OUTPUT_PRESETS[target]?.url || '').trim();
        const streamKey = String(body.streamKey || '').trim();
        if (!/^rtmps?:\/\/\S+/.test(url)) return fail('url must start with rtmp:// or rtmps://');
        if (!streamKey) return fail('streamKey is required');
        const existing = config.outputs?.[target];
        if (existing?.uid) await stream.deleteOutput(env, config.liveInput.uid, existing.uid).catch(() => {});
        const r = await stream.createOutput(env, config.liveInput.uid, { url, streamKey, enabled: body.enabled !== false });
        if (!r.ok) return fail(`Stream: ${stream.errorMessage(r)}`, 500);
        config.outputs = { ...(config.outputs || {}), [target]: { uid: r.result?.uid || null, url, keyMask: stream.mask(streamKey), enabled: body.enabled !== false, createdAt: new Date().toISOString(), by: userEmail } };
        await b.writeConfig(env.DB, config);
        await logAudit(env.DB, { userEmail, action: 'updated', entityType: 'live-input', entitySlug: config.liveInput.uid, entityName: `Simulcast output set: ${target}`, gitStatus: 'ok' });
        return Response.json({ success: true, output: config.outputs[target] });
      }
      case 'toggleOutput': {
        const target = String(body.target || '').toLowerCase();
        const o = config.outputs?.[target];
        if (!o?.uid || !config.liveInput?.uid) return fail('No such output');
        const r = await stream.updateOutput(env, config.liveInput.uid, o.uid, { enabled: !!body.enabled });
        if (!r.ok) return fail(`Stream: ${stream.errorMessage(r)}`, 500);
        config.outputs[target] = { ...o, enabled: !!body.enabled };
        await b.writeConfig(env.DB, config);
        return Response.json({ success: true, output: config.outputs[target] });
      }
      case 'removeOutput': {
        const target = String(body.target || '').toLowerCase();
        const o = config.outputs?.[target];
        if (!o) return fail('No such output');
        if (o.uid && config.liveInput?.uid) await stream.deleteOutput(env, config.liveInput.uid, o.uid).catch(() => {});
        delete config.outputs[target];
        await b.writeConfig(env.DB, config);
        return Response.json({ success: true });
      }
      case 'setConfig': {
        const c = config;
        const p = body.config || body;
        if (p.facebook) {
          if (p.facebook.mode && ['persistent', 'api'].includes(p.facebook.mode)) c.facebook.mode = p.facebook.mode;
          if (typeof p.facebook.pageUrl === 'string' && /^https:\/\/(www\.)?facebook\.com\//.test(p.facebook.pageUrl)) c.facebook.pageUrl = p.facebook.pageUrl.trim();
        }
        if (p.youtube && typeof p.youtube.channelUrl === 'string') c.youtube.channelUrl = p.youtube.channelUrl.trim().slice(0, 200);
        if (p.reminders) {
          for (const k of ['enabled', 'sms', 'push']) if (typeof p.reminders[k] === 'boolean') c.reminders[k] = p.reminders[k];
          if (Array.isArray(p.reminders.hoursBefore)) c.reminders.hoursBefore = p.reminders.hoursBefore.map(Number).filter(n => [24, 1].includes(n));
        }
        if (p.replayHours !== undefined) c.replayHours = Math.min(24 * 30, Math.max(1, Number(p.replayHours) || 72));
        if (typeof p.timezone === 'string' && p.timezone.length < 64) { try { new Intl.DateTimeFormat('en-US', { timeZone: p.timezone }); c.timezone = p.timezone; } catch { return fail('Unknown timezone'); } }
        if (p.alerts && Array.isArray(p.alerts.emails)) c.alerts.emails = p.alerts.emails.map(s => String(s).trim().toLowerCase()).filter(notify.isEmail).slice(0, 10);
        if (p.defaults) {
          if (typeof p.defaults.title === 'string') c.defaults.title = p.defaults.title.trim().slice(0, 140) || c.defaults.title;
          if (typeof p.defaults.message === 'string') c.defaults.message = p.defaults.message.trim().slice(0, 200) || c.defaults.message;
        }
        if (typeof p.customerCode === 'string' && /^[a-z0-9]{8,32}$/.test(p.customerCode)) c.customerCode = p.customerCode;
        await b.writeConfig(env.DB, c);
        await logAudit(env.DB, { userEmail, action: 'updated', entityType: 'live-status', entitySlug: 'broadcast-config', entityName: 'Broadcast settings', gitStatus: 'ok' });
        return Response.json({ success: true, config: redactConfig(c, false) });
      }
      case 'generateVapid': {
        if (config.vapid?.publicKey && !body.force) return fail('Push keys already exist. Regenerating would orphan every existing browser subscription; pass force to do it anyway.');
        config.vapid = await notify.generateVapidKeys();
        await b.writeConfig(env.DB, config);
        if (body.force) await env.DB.prepare(`UPDATE broadcast_reminders SET unsubscribed_at = ? WHERE channel = 'push' AND unsubscribed_at IS NULL`).bind(new Date().toISOString()).run();
        return Response.json({ success: true, publicKey: config.vapid.publicKey });
      }
      case 'testStream': {
        const t = await stream.checkToken(env);
        let input = null;
        if (t.ok && config.liveInput?.uid) { const r = await stream.getLiveInput(env, config.liveInput.uid); input = r.ok ? stream.redactInput(r.result) : { error: stream.errorMessage(r) }; }
        return Response.json({ success: t.ok, token: t, input });
      }
      case 'testFacebook': {
        const t = await fb.checkFbToken(env);
        const [recent, info] = await Promise.all([t.ok ? fb.fbRecentBroadcasts(env, 5) : null, fb.fbTokenInfo(env)]);
        return Response.json({ success: t.ok, token: t, recent, info });
      }
      case 'testHub': {
        const s = await b.hubStatus(env);
        return Response.json({ success: !!s.ok, hub: s });
      }
      case 'testAlert': {
        const r = await notify.alertAdmins(env, config, { level: 'info', title: 'Test alert from the Broadcast control center', detail: `Sent by ${userEmail}. If you can read this, alerts work.`, url: `${b.SITE_ORIGIN}/admin/` });
        return Response.json({ success: true, result: r });
      }
      case 'runTick': {
        const r = await b.runTick(env, { source: 'admin', force: true, by: userEmail });
        const state = await b.readState(env.DB);
        await b.publishToHub(env, state, config, 'admin:tick');
        return Response.json({ success: true, ...r });
      }
      case 'lifecycle': {
        const lc = config.liveInput?.uid ? await stream.lifecycle(config.customerCode, config.liveInput.uid) : null;
        const viewers = config.liveInput?.uid ? await stream.liveViewers(config.customerCode, config.liveInput.uid) : null;
        return Response.json({ success: true, lifecycle: lc, viewers });
      }
      case 'sendTestReminder': {
        const kind = ['scheduled', 'day', 'hour', 'live', 'replay'].includes(body.kind) ? body.kind : 'live';
        const email = String(body.email || userEmail).trim().toLowerCase();
        if (!notify.isEmail(email)) return fail('email is invalid');
        const state = await b.readState(env.DB);
        const tpl = notify.reminderEmail({ kind, kidName: state.kidName || 'Sample', scheduledAt: state.scheduledAt || new Date(Date.now() + 86400e3).toISOString(), liveUrl: b.liveUrlFor(state), replayUrl: b.liveUrlFor(state), unsubscribeUrl: `${b.SITE_ORIGIN}/api/reminders?unsubscribe=test`, tz: config.timezone });
        const r = await notify.sendEmails(env, { to: [email], subject: `[TEST] ${tpl.subject}`, html: tpl.html, text: tpl.text });
        return Response.json({ success: r.sent > 0, result: r });
      }
      default:
        return fail(`Unknown action "${action}"`);
    }
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
