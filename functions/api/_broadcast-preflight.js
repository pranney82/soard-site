/**
 * Go / no-go before a reveal
 * ==========================
 * One checklist that says whether reveal day will work, run three ways:
 * the admin's "Run checks" button, on its own an hour before a scheduled
 * reveal (posted to Slack), and again 10 minutes before if anything was
 * still open at the hour mark.
 *
 * Item status: ok · warn (works, but fix it if you can) · fail (the reveal
 * won't reach people properly) · unknown (can't be checked from here) · off
 * (not used). `fix` says what to do. ready = no fails.
 */

import * as stream from './_stream-live.js';
import * as fb from './_broadcast-fb.js';
import * as yt from './_youtube.js';
import * as notify from './_broadcast-notify.js';
import { ADMIN_URL } from './_broadcast-monitor.js';

const MIC_CHECK_FRESH_MS = 48 * 3600e3;
const nowIso = () => new Date(Date.now()).toISOString();
const ago = (iso) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 36 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

const VERDICT_WORDS = { quiet: 'very quiet', loud: 'very loud', onesided: 'sound on one side only', silent: 'no sound', none: 'no audio track', unknown: 'not measured' };

/**
 * Run every check. `hub` is hubStatus(env) from the caller (the hub lives
 * behind _broadcast.js, which imports this module).
 */
export async function run(env, config, state, health, { hub = null } = {}) {
  const items = [];
  const add = (key, status, label, detail = null, fix = null) => items.push({ key, status, label, detail, fix });

  // Stream: the phone has somewhere to go
  if (!stream.streamConfigured(env)) add('stream', 'fail', 'Cloudflare Stream isn\'t configured', null, 'Set CF_ACCOUNT_ID and CF_STREAM_TOKEN in Cloudflare Pages.');
  else {
    const t = await stream.checkToken(env);
    if (!t.ok) add('stream', 'fail', 'Cloudflare Stream isn\'t answering', t.error, 'Settings → System checks has the details.');
    else if (!config.liveInput?.uid) add('stream', 'fail', 'No live input for the phone', null, 'Settings → Phones → Create the live input, then scan its code with the phone.');
    else {
      const li = await stream.getLiveInput(env, config.liveInput.uid);
      if (!li.ok) add('stream', 'fail', 'The live input is missing in Stream', stream.errorMessage(li), 'Settings → Phones → Refresh, or create it again (phones then rescan).');
      else if (li.result?.enabled === false) add('stream', 'fail', 'The live input is switched off', 'Phones are refused.', 'Settings → Phones → Switch on.');
      else add('stream', 'ok', 'Stream is ready for the phone');
    }
  }

  // Mic check on the private rehearsal feed
  const r = health?.rehearsal;
  if (!config.rehearsalInput?.uid) add('micCheck', 'warn', 'No rehearsal feed for a private mic check', null, 'Settings → Phones → Create rehearsal feed, then scan its code with the phone.');
  else if (r?.goodAt && Date.now() - Date.parse(r.goodAt) < MIC_CHECK_FRESH_MS) add('micCheck', 'ok', `Mic check passed ${ago(r.goodAt)}`, r.goodLufs != null ? `${Math.round(r.goodLufs)} LUFS` : null);
  else if (r?.lastAt && Date.now() - Date.parse(r.lastAt) < MIC_CHECK_FRESH_MS) add('micCheck', 'warn', `Last mic check had a problem: ${VERDICT_WORDS[r.verdict] || r.verdict}`, ago(r.lastAt), 'Check the mic and run the rehearsal feed again until the mic check says "Sound is good".');
  else add('micCheck', 'warn', 'No mic check in the last 2 days', null, 'Phone on the rehearsal code, start Larix, talk normally, and watch the mic check on Broadcast → Now.');

  // Facebook
  const fbMode = config.facebook?.mode === 'api' ? 'api' : 'persistent';
  const outputs = config.liveInput?.uid && stream.streamConfigured(env) ? await stream.listOutputs(env, config.liveInput.uid).catch(() => null) : null;
  const listed = (target) => {
    const cfg = config.outputs?.[target];
    if (!cfg) return null;
    const l = outputs?.ok ? (outputs.result || []).find((o) => o.uid === cfg.uid) : null;
    return { exists: outputs?.ok ? !!l : true, enabled: l ? l.enabled !== false : cfg.enabled !== false };
  };
  if (fbMode === 'api') add('facebookOutput', 'ok', 'Facebook API mode creates the post and output when the phone connects');
  else {
    const o = listed('facebook');
    if (!o) add('facebookOutput', 'fail', 'Facebook isn\'t set up', null, 'Settings → Facebook: paste the persistent stream key from Live Producer.');
    else if (!o.exists) add('facebookOutput', 'fail', 'The Facebook output is missing in Stream', null, 'Settings → Facebook: paste the stream key again.');
    else if (!o.enabled) add('facebookOutput', 'warn', 'The Facebook output is paused', null, 'Settings → Facebook → Resume.');
    else add('facebookOutput', 'ok', 'Stream will send the reveal to Facebook');
  }
  const tok = await fb.checkFbToken(env);
  if (tok.configured === false) add('facebookToken', 'warn', 'The site can\'t see the Facebook Page', 'FB_PAGE_ID / FB_PAGE_TOKEN aren\'t set, so it can\'t confirm Facebook went live.', null);
  else if (!tok.ok) add('facebookToken', 'fail', 'The Facebook token stopped working', tok.error, 'Regenerate the Page token (docs/facebook-app-review.md) and update FB_PAGE_TOKEN.');
  else {
    add('facebookToken', 'ok', `Connected to the Facebook Page${tok.name ? ` "${tok.name}"` : ''}`);
    if (fbMode === 'persistent') {
      const s = await fb.fbScheduledLive(env);
      if (s.found) add('facebookPost', 'ok', 'A Facebook live post is scheduled', s.title || null);
      else add('facebookPost', 'unknown', 'Couldn\'t find a scheduled Facebook live post', 'With the persistent key, Facebook only goes live from a scheduled post or a Go Live press.', 'Schedule the post in Live Producer, or have someone ready to press Go Live there when the phone starts.');
    }
  }

  // YouTube
  const yo = listed('youtube');
  if (!yo) add('youtube', 'off', 'YouTube isn\'t set up (optional)');
  else if (!yo.exists) add('youtube', 'fail', 'The YouTube output is missing in Stream', null, 'Settings → YouTube: paste the stream key again.');
  else if (!yo.enabled) add('youtube', 'warn', 'The YouTube output is paused', null, 'Settings → YouTube → Resume.');
  else if (!yt.youtubeConfigured(env)) add('youtube', 'ok', 'Stream will send the reveal to YouTube', 'Add YOUTUBE_API_KEY so the site can confirm it actually went live. Make sure Auto-start is on in YouTube Studio.');
  else {
    const ch = await yt.resolveChannel(env, config.youtube?.channelUrl);
    if (!ch.ok) add('youtube', 'warn', 'Stream will send to YouTube, but the channel can\'t be checked', ch.error, 'Fix the YouTube channel URL in Settings → YouTube.');
    else add('youtube', 'ok', `Stream will send the reveal to YouTube (${ch.title || 'channel found'})`, 'Auto-start must be on in YouTube Studio for it to go live by itself.');
  }

  // Alerts reach Slack
  // Live problems go to the Needs attention channel, or the good-news one when that's all there is
  const slackCfg = env.SLACK_BOT_TOKEN ? await notify.readSlackConfig(env.DB).catch(() => ({})) : {};
  const slackChannel = slackCfg.attention?.id ? slackCfg.attention : slackCfg.channel;
  if (env.SLACK_BOT_TOKEN && !slackChannel?.id && !env.SLACK_WEBHOOK_URL) add('slack', 'fail', 'No Slack channel is picked for alerts', 'Nobody hears about silent audio or a frozen picture unless they are watching.', 'Pick the channel in Settings → Alerts.');
  else if (notify.slackConfigured(env)) add('slack', 'ok', `Problems during the reveal post to Slack${slackChannel?.name ? ` (#${slackChannel.name})` : ''}`);
  else add('slack', 'fail', 'Slack alerts aren\'t set up', 'Nobody hears about silent audio or a frozen picture unless they are watching.', 'Add the Slack app\'s SLACK_BOT_TOKEN in Cloudflare Pages, then pick the channel in Settings → Alerts.');

  // Site plumbing
  if (hub) add('hub', hub.ok ? 'ok' : 'warn', hub.ok ? 'The live page updates instantly' : 'The real-time hub isn\'t answering', hub.ok ? null : `${hub.error || 'unreachable'}. Pages fall back to checking every 10 seconds.`, hub.ok ? null : 'Redeploy workers/live-hub, then the site.');

  // The reveal itself
  if (['scheduled', 'armed'].includes(state.phase)) {
    if (state.kidSlug) add('kid', 'ok', `Reveal for ${state.kidName || state.kidSlug}`, state.scheduledAt ? `Starts ${new Date(state.scheduledAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: config.timezone || 'America/New_York' })}` : null);
    else add('kid', 'warn', 'No kid for this reveal', 'The live page and the "we\'re live" email can\'t name them.', 'The kid comes from the JobTread job name, like "Max Sample (2026)". Check it matches a published kid page.');
  }

  const counts = { ok: 0, warn: 0, fail: 0, unknown: 0, off: 0 };
  for (const i of items) counts[i.status]++;
  return { at: nowIso(), broadcastId: state.broadcastId || null, ready: counts.fail === 0, counts, items };
}

const ICON = { ok: '✅', warn: '⚠️', fail: '❌', unknown: '❔', off: '➖' };

/** The go/no-go as a Slack post. */
export function slackText(result, state, config) {
  const when = state.scheduledAt ? new Date(state.scheduledAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: config.timezone || 'America/New_York' }) : null;
  const open = result.items.filter((i) => i.status === 'fail' || i.status === 'warn' || i.status === 'unknown');
  const title = `${result.ready ? (result.counts.warn || result.counts.unknown ? 'Go, with notes' : 'Go') : 'No-go'}: ${state.title || 'the reveal'}${when ? ` at ${when}` : ''}`;
  const lines = open.length
    ? open.map((i) => `${ICON[i.status]} ${i.label}${i.detail ? ` (${i.detail})` : ''}${i.fix ? `\n      → ${i.fix}` : ''}`)
    : ['Everything checks out.'];
  lines.push(`${result.counts.ok} of ${result.items.filter((i) => i.status !== 'off').length} checks pass.`);
  return { level: result.counts.fail ? 'error' : open.length ? 'warn' : 'info', icon: result.counts.fail ? '🚨' : open.length ? '⚠️' : '🚦', title, detail: lines.join('\n') };
}

/**
 * The go/no-go in a line or two, for the staff text: all green; or what isn't
 * ready and what to do first; or what to look at when it's a go with notes
 */
export function textLine(result) {
  const total = result.items.filter((i) => i.status !== 'off').length;
  const fails = result.items.filter((i) => i.status === 'fail');
  const notes = result.items.filter((i) => i.status === 'warn' || i.status === 'unknown');
  const list = (items) => items.map((i) => i.label.replace(/\.$/, '')).join('; ');
  if (!fails.length && !notes.length) return `All green: ${result.counts.ok} of ${total} checks pass.`;
  if (fails.length) return [`Not ready: ${list(fails)}.`, fails[0].fix ? `First: ${fails[0].fix}` : null].filter(Boolean).join(' ');
  return `${result.counts.ok} of ${total} pass. Check: ${list(notes)}.`;
}

/** The whole go/no-go text: 🟢 a go, ⚠️ a go with notes, 🚨 "SOARD ALERT:" for a no-go */
export function goText(result, state, config) {
  const post = slackText(result, state, config);
  return notify.alertText({ title: post.title, detail: textLine(result), url: ADMIN_URL, tone: result.counts.fail ? 'alert' : 'info', icon: result.counts.fail ? '🚨' : post.level === 'warn' ? '⚠️' : '🟢' });
}

/**
 * runTick: an hour before a scheduled reveal, run the go/no-go and post it.
 * Ten minutes before, post again if anything was still open. Once each per reveal.
 */
export async function auto(env, config, state, health, work, { hubStatus } = {}) {
  if (!['scheduled', 'armed'].includes(state.phase) || !state.scheduledAt) return;
  const toGo = Date.parse(state.scheduledAt) - Date.now();
  if (toGo > 60 * 60e3 || toGo < -15 * 60e3) return;
  const p = health.preflight?.broadcastId === state.broadcastId ? health.preflight : { broadcastId: state.broadcastId, posted: {}, last: null };
  const stage = toGo <= 10 * 60e3 ? 't10' : 't60';
  if (p.posted[stage]) return;
  if (stage === 't10' && p.posted.t60 && p.last && !p.last.counts.fail && !p.last.counts.warn && !p.last.counts.unknown) {
    p.posted.t10 = 'not needed';
    health.preflight = p;
    return;
  }
  const result = await run(env, config, state, health, { hub: hubStatus ? await hubStatus(env).catch(() => null) : null });
  const post = slackText(result, state, config);
  await notify.alertAdmins(env, config, { ...post, url: ADMIN_URL, context: stage === 't60' ? 'Automatic check an hour before' : 'Automatic check 10 minutes before', urgent: post.level === 'error',
    text: goText(result, state, config) });
  p.last = result;
  p.posted[stage] = nowIso();
  health.preflight = p;
  work.push(`preflight:${stage}`);
}
