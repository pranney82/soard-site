/**
 * The AI spending watch
 * ===========================================================================
 * Hourly on the live hub's heartbeat: what each site's AI has cost, by feature,
 * from Cloudflare's own numbers. The store is its own site on the same
 * Cloudflare account, so it's watched from here too (Cloudflare's alerts come a
 * day late and only for the whole account).
 *
 * The gateways' daily dollar caps stop a runaway by themselves (_ai.js). This is
 * what says it happened: one post in Needs attention (and the alert email) when
 * a site or a feature jumps, a cap turns calls away, or AI runs outside the
 * gateways, a reply in that post if it doubles, and ✅ when it settles.
 *
 * Reads counts and dollars, never a word of what was asked. Kept in spend_state
 * 'ai-watch' for Site → Automations.
 *
 * Needs CF_ANALYTICS_TOKEN (an API token with only Account Analytics: Read) and
 * CF_ACCOUNT_ID, set in Cloudflare Pages. Without the token it does nothing and
 * Automations says so; the caps don't need it.
 */

import { readState, writeState } from './_mercury.js';
import { alertAdmins, slackResolved } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { readConfig } from './_broadcast.js';

const KEY = 'ai-watch';
const EVERY_MS = 60 * 60 * 1000;
const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const NEURON_DOLLARS = 0.011 / 1000;
const USUAL_DAYS = 14;

// What counts as a jump. A normal day is under $1; the busiest in the two weeks before this was built was $1.97, and
// the Nov 5 2026 spike ran about $4 an hour. A day must also be 3 times the usual, so a site that grows isn't flagged
const SITE_HOUR = 1;
const SITE_DAY = 2.5;
const FEATURE_HOUR = 0.75;
const FEATURE_DAY = 2;
const OUTSIDE_HOUR = 0.25;
const JUMP = 3;

export const SITES = { 'soard-site': 'SOARD', 'sunnyandranney-site': 'the store' };
const FEATURES = {
  'applicant-messages': 'family messages', 'board-asks': 'board report asks', 'board-file-reading': 'reading board files',
  'board-mail': 'board email', 'board-minutes': 'board minutes', 'board-shorter': 'shorter board reports',
  'broadcast-reel': 'reveal reels', 'live-messages': 'live reveal messages', 'mail-sweep': 'the inbox sweep',
  'press-monitor': 'the press monitor', 'score-scans': 'scanned scoresheets', translate: 'Spanish translation',
  'vendor-papers': 'W-9s and insurance', 'content-helper': 'admin writing help', 'people-bios': 'People bios',
  orders: 'store order emails (kid items)', 'kid-parts': 'selections as parts (kid items)', 'checkin-scan': 'box labels scanned at check-in (kid items)',
  chat: 'store chat', 'chat-search': 'store chat search', 'chat-summary': 'store chat summaries', 'product-sync': 'the store’s product sync',
};
export const featureName = (f) => FEATURES[f] || f;

export const dollars = (n) => (n > 0 && n < 0.005 ? 'under a cent' : `$${(n || 0).toFixed(2)}`);
const GATEWAY_URL = (account) => `https://dash.cloudflare.com/${account}/ai/ai-gateway`;

const QUERY = `query AiWatch($account: String!, $from: Date!, $to: Date!, $day: Time!, $hour: Time!, $now: Time!, $fromHour: Time!, $toHour: Time!, $dayHour: Time!, $lastHour: Time!, $thisHour: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    days: aiInferenceAdaptiveGroups(limit: 1000, filter: { date_geq: $from, date_lt: $to }) { dimensions { tag } sum { totalNeurons } }
    day: aiInferenceAdaptiveGroups(limit: 200, filter: { datetime_geq: $day, datetime_lt: $now }) { dimensions { tag } sum { totalNeurons } }
    hour: aiInferenceAdaptiveGroups(limit: 200, filter: { datetime_geq: $hour, datetime_lt: $now }) { dimensions { tag } sum { totalNeurons } }
    gatewayDays: aiGatewayRequestsAdaptiveGroups(limit: 300, filter: { datetimeHour_geq: $fromHour, datetimeHour_lt: $toHour }) { dimensions { gateway model feature: metadataValue(key: "feature") } sum { cost } }
    gatewayDay: aiGatewayRequestsAdaptiveGroups(limit: 300, filter: { datetimeHour_geq: $dayHour, datetimeHour_lt: $thisHour }) { dimensions { gateway model statusCode feature: metadataValue(key: "feature") } count sum { cost } }
    gatewayHour: aiGatewayRequestsAdaptiveGroups(limit: 300, filter: { datetimeHour_geq: $lastHour, datetimeHour_lt: $thisHour }) { dimensions { gateway model statusCode feature: metadataValue(key: "feature") } count sum { cost } }
  } }
}`;

const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** Cloudflare's numbers for the last while → the account's raw rows. Throws on a refused token or a failed query */
export async function readUsage(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  // (the gateway's numbers come by the clock hour: whole hours only, so "the last hour" is an hour and not nearly two)
  const thisHour = Math.floor(now / 3600e3) * 3600e3;
  const from = new Date(now - USUAL_DAYS * 86400e3).toISOString().slice(0, 10);
  const to = new Date(now).toISOString().slice(0, 10);
  const variables = {
    account: env.CF_ACCOUNT_ID, from, to, fromHour: `${from}T00:00:00Z`, toHour: `${to}T00:00:00Z`,
    day: stamp(now - 86400e3), hour: stamp(now - 3600e3), now: stamp(now),
    dayHour: stamp(thisHour - 86400e3), lastHour: stamp(thisHour - 3600e3), thisHour: stamp(thisHour),
  };
  const res = await fetchImpl(GRAPHQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${String(env.CF_ANALYTICS_TOKEN).trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new Error(`Cloudflare answered ${res.status}`);
  if (body.errors?.length) throw new Error(String(body.errors[0].message || 'Cloudflare refused the question').slice(0, 200));
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('Cloudflare found no such account for this token');
  return account;
}

const costOf = (row) => (row.sum?.totalNeurons || 0) * NEURON_DOLLARS;
const whose = (tag) => { const m = /^([^:]+):(.+)$/.exec(tag || ''); return m ? { site: m[1], feature: m[2] } : { site: '', feature: '' }; };
const notWorkersAi = (row) => !String(row.dimensions?.model || '').startsWith('@cf/');

/**
 * The raw rows → { sites: [{ id, name, hour, day, usual, features: [{ feature, hour, day, usual, refused }] }], outsideHour, refused }.
 * Workers AI's cost is its neurons (what's billed, gateway or not, so it's the one that sees a call that went around
 * one); Anthropic's is the gateway's estimate. `usual` is an average day of the fortnight before, of both.
 */
export function summarize(rows) {
  const sites = new Map();
  const site = (id) => {
    if (!sites.has(id)) sites.set(id, { id, name: SITES[id] || id, hour: 0, day: 0, usual: 0, features: new Map() });
    return sites.get(id);
  };
  const feature = (id, f) => {
    const s = site(id);
    if (!s.features.has(f)) s.features.set(f, { feature: f, hour: 0, day: 0, usual: 0, refused: 0 });
    return s.features.get(f);
  };
  let outsideHour = 0;
  const add = (list, field, share = 1) => {
    for (const row of list || []) {
      const { site: id, feature: f } = whose(row.dimensions?.tag);
      if (!id) { if (field === 'hour') outsideHour += costOf(row); continue; }
      const cost = costOf(row) * share;
      site(id)[field] += cost;
      feature(id, f)[field] += cost;
    }
  };
  add(rows.days, 'usual', 1 / USUAL_DAYS);
  add(rows.day, 'day');
  add(rows.hour, 'hour');
  for (const [list, field, share] of [[rows.gatewayDays, 'usual', 1 / USUAL_DAYS], [rows.gatewayDay, 'day', 1], [rows.gatewayHour, 'hour', 1]]) {
    for (const row of list || []) {
      const id = row.dimensions?.gateway;
      if (!SITES[id] || !notWorkersAi(row)) continue;
      const cost = (row.sum?.cost || 0) * share;
      site(id)[field] += cost;
      feature(id, row.dimensions?.feature || 'other')[field] += cost;
    }
  }
  let refused = 0;
  for (const row of rows.gatewayHour || []) {
    const id = row.dimensions?.gateway;
    if (!SITES[id] || row.dimensions?.statusCode !== 429) continue;
    feature(id, row.dimensions?.feature || 'other').refused += row.count || 0;
    refused += row.count || 0;
  }
  return {
    outsideHour, refused,
    sites: [...sites.values()].map((s) => ({ ...s, features: [...s.features.values()].sort((a, b) => b.day - a.day) })).sort((a, b) => b.day - a.day),
  };
}

const jumped = (x, hourAt, dayAt) => x.hour >= hourAt || (x.day >= dayAt && x.day >= JUMP * x.usual);

/** What needs saying → [{ key, what, amount, title, detail, facts, fix }], worst first. A site's jump is said once, by the feature behind it */
export function judge(model) {
  const out = [];
  for (const s of model.sites) {
    const features = s.features.filter((f) => jumped(f, FEATURE_HOUR, FEATURE_DAY));
    for (const f of features) {
      out.push({
        key: `${s.id}:${f.feature}`, what: `${featureName(f.feature)} (${s.name})`, amount: f.day,
        title: `AI spending jumped: ${featureName(f.feature)}`,
        detail: `${featureName(f.feature)} on ${s.name === 'SOARD' ? 'SOARD’s site' : s.name} cost ${dollars(f.hour)} in the last hour and ${dollars(f.day)} in the last 24 hours. A usual day is ${dollars(f.usual)}.`,
        facts: [`*All of ${s.name}, 24 hours:* ${dollars(s.day)}`],
      });
    }
    if (!features.length && jumped(s, SITE_HOUR, SITE_DAY)) {
      out.push({
        key: `${s.id}:all`, what: s.name, amount: s.day,
        title: `AI spending jumped: ${s.name}`,
        detail: `${s.name === 'SOARD' ? 'SOARD’s site' : s.name} cost ${dollars(s.hour)} in AI in the last hour and ${dollars(s.day)} in the last 24 hours. A usual day is ${dollars(s.usual)}.`,
        facts: s.features.slice(0, 3).map((f) => `*${featureName(f.feature)}:* ${dollars(f.day)}`),
      });
    }
    for (const f of s.features.filter((x) => x.refused)) {
      out.push({
        key: `${s.id}:${f.feature}:cap`, what: `${featureName(f.feature)} at its cap`, amount: f.day, urgent: true,
        title: `AI cap reached: ${featureName(f.feature)}`,
        detail: `Cloudflare turned away ${f.refused} AI ${f.refused === 1 ? 'call' : 'calls'} for ${featureName(f.feature)} on ${s.name === 'SOARD' ? 'SOARD’s site' : s.name} in the last hour, because a cap was reached. SOARD’s jobs wait and carry on when it lifts; it lifts as the last 24 hours’ spending falls.`,
        facts: [`*${featureName(f.feature)}, 24 hours:* ${dollars(f.day)}`, `*All of ${s.name}, 24 hours:* ${dollars(s.day)}`],
      });
    }
  }
  if (model.outsideHour >= OUTSIDE_HOUR) {
    out.push({
      key: 'outside', what: 'AI outside the gateways', amount: model.outsideHour,
      title: 'AI is running outside the gateways',
      detail: `${dollars(model.outsideHour)} of AI ran in the last hour with no site’s name on it, so no cap covers it. Something on the Cloudflare account is calling Workers AI directly.`,
      facts: [],
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/** One look: read, say what's new, clear what's settled → the kept state */
export async function checkAiSpending(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  const last = await readState(env.DB, KEY);
  const model = summarize(await readUsage(env, { now, fetchImpl }));
  const problems = judge(model);
  const open = { ...(last.open || {}) };
  const config = await readConfig(env.DB).catch(() => ({}));
  for (const p of problems) {
    const was = open[p.key];
    // (a cap is said once while it holds; a jump again if it doubles)
    if (was && (p.key.endsWith(':cap') || p.amount < was.amount * 2)) continue;
    await alertAdmins(env, config, {
      level: 'warn', icon: '💸', title: was ? `Still climbing: ${p.title}` : p.title, detail: p.detail, facts: p.facts,
      url: GATEWAY_URL(env.CF_ACCOUNT_ID), urlLabel: 'Open AI Gateway', issue: `ai-watch:${p.key}`, urgent: !!p.urgent,
      fix: 'Nothing has to be stopped by hand: the daily caps hold SOARD at $5 and the store at $4. Open AI Gateway to see what’s behind it.',
    });
    open[p.key] = { what: p.what, amount: p.amount, at: was?.at || now };
  }
  const flagged = new Set(problems.map((p) => p.key));
  // (a site still over the line stays open while a feature takes over saying so: it hasn't settled)
  for (const s of model.sites) if (jumped(s, SITE_HOUR, SITE_DAY)) flagged.add(`${s.id}:all`);
  for (const [key, o] of Object.entries(open)) {
    if (flagged.has(key)) continue;
    await slackResolved(env, `ai-watch:${key}`, slackCard({ icon: '✅', title: `AI spending settled: ${o.what}`, lead: 'It’s back under the line, so nothing to do.' }), { summary: 'Back under the line.' }).catch(() => null);
    delete open[key];
  }
  return writeState(env.DB, KEY, {
    at: now, error: null, runningUntil: 0, open,
    sites: model.sites.map((s) => ({ id: s.id, name: s.name, hour: s.hour, day: s.day, usual: s.usual, top: s.features.slice(0, 4).filter((f) => f.day >= 0.005).map((f) => ({ name: featureName(f.feature), day: f.day })) })),
  });
}

/** On the live hub's heartbeat: hourly. Never throws */
export async function maybeRunAiWatch(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!env?.DB || !env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return null;
  try {
    const st = await readState(env.DB, KEY);
    if (now - (st.at || 0) < EVERY_MS || (st.runningUntil || 0) > now) return null;
    await writeState(env.DB, KEY, { runningUntil: now + 60 * 1000 });
    return await checkAiSpending(env, { now, fetchImpl });
  } catch (err) {
    console.error('[ai-watch]', err.message);
    // Never stuck: the time is kept, so it's tried again in an hour, not every minute
    await writeState(env.DB, KEY, { at: now, error: String(err.message || err).slice(0, 200), runningUntil: 0 }).catch(() => {});
    return null;
  }
}

/** For Site → Automations: dollars and names of features, never what was asked */
export async function aiWatchFacts(env) {
  const s = await readState(env.DB, KEY);
  return { token: !!String(env.CF_ANALYTICS_TOKEN || '').trim(), at: s.at ? new Date(s.at).toISOString() : null, error: s.error || null, sites: s.sites || [], open: Object.values(s.open || {}).map((o) => o.what) };
}
