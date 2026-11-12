/**
 * Where the site lives: live facts for Site → Automations → Hosting
 * =================================================================
 * Three reads, each on its own (one that fails never blanks the others):
 *
 *  - pages:   the site's production builds on Cloudflare Pages (project
 *             soard-site), through CF_PAGES_TOKEN (Pages: Read), summed up the
 *             way Publish does (pending-changes.js): the live build, one still
 *             running, the newest one failing. Commits by short sha only.
 *  - github:  the newest commit on main in github.com/sunshineonaranneyday/soard-site, and
 *             what Cloudflare did with it (live, building, failed or no build).
 *             Sha and time only, never the message.
 *  - domains: each of SOARD's four domains as its registry's RDAP answers:
 *             who it's registered with, when it's paid through, its
 *             nameservers. Public data, no key; a good answer is kept 6 hours.
 *  - keys:    how many keys are set in Cloudflare for the site, and the names
 *             of any no code reads (READ_KEYS). Names only, never a value.
 *
 * Read when Site → Automations opens (automations-admin.js). Nothing here
 * writes anywhere.
 */

import { summarizeDeploys } from './pending-changes.js';

export const PAGES_PROJECT = 'soard-site';
export const REPO = 'sunshineonaranneyday/soard-site';

// The registry's RDAP server for each domain's TLD (rdap.org's redirects fail from Workers often enough to skip it)
const RDAP = {
  com: 'https://rdap.verisign.com/com/v1/domain/',
  org: 'https://rdap.publicinterestregistry.org/rdap/domain/',
};
export const DOMAINS = ['sunshineonaranneyday.com', 'soardcharity.com', 'sunshineonaranneyday.org', 'sunnyandranney.com'];

// Every key the site's code or build reads from Cloudflare (tests/hosting.test.mjs scans the code, so this can't fall behind).
// A key set in Cloudflare and missing here is one nothing uses.
export const READ_KEYS = new Set([
  'ALERT_EMAILS', 'APPLY_IP_PEPPER', 'CALENDAR_LINK_SECRET',
  'CF_ACCESS_API_TOKEN', 'CF_ACCESS_AUD', 'CF_ACCESS_ISS', 'CF_ACCESS_MCP_AUD', 'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCOUNT_ID', 'CF_ANALYTICS_TOKEN', 'CF_API_TOKEN', 'CF_DEPLOY_HOOK', 'CF_IMAGES_TOKEN', 'CF_PAGES_DEPLOY_HOOK', 'CF_PAGES_TOKEN', 'CF_STREAM_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_D1_ID', 'D1_DATABASE_ID', 'DEPLOY_HOOK_URL',
  'COMPANYCAM_CUSTOMER_STAGE', 'COMPANYCAM_TOKEN', 'ESRI_CLIENT_ID', 'ESRI_CLIENT_SECRET', 'FB_PAGE_ID', 'FB_PAGE_TOKEN',
  'GITHUB_BRANCH', 'GITHUB_REPO', 'GITHUB_TOKEN', 'GOOGLE_CALENDAR_KEY', 'GOOGLE_MAPS_KEY',
  'JOBTREAD_GRANT_KEY', 'JOBTREAD_QC_GRANT_KEY', 'JOBTREAD_WEBHOOK_SECRET', 'JOTFORM_API_KEY',
  'KIT_API_KEY', 'KIT_EMAIL_TEMPLATE_ID', 'KIT_FORM_ID', 'LIVE_IP_PEPPER',
  'MERCURY_API_TOKEN', 'MERCURY_RELAY_KEY', 'PLAID_CLIENT_ID', 'PLAID_ENV', 'PLAID_SECRET',
  'QBO_CLIENT_ID', 'QBO_CLIENT_SECRET', 'QBO_ENV', 'RAMP_CLIENT_ID', 'RAMP_CLIENT_SECRET',
  'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'REVEAL_INVITE_ORGANIZERS', 'SITE_ORIGIN',
  'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_WEBHOOK_URL', 'STREAM_WEBHOOK_SECRET',
  'TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY',
  'TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_API_KEY_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID',
  'YOUTUBE_API_KEY', 'ZEFFY_API_KEY', 'ZEFFY_WEBHOOK_SECRET',
]);
// What Cloudflare itself may put in a build's environment
const CF_SYSTEM = new Set(['CF_PAGES', 'CF_PAGES_BRANCH', 'CF_PAGES_COMMIT_SHA', 'CF_PAGES_URL']);

/** The keys set for the site → { set, unused }: a count, and the names of any no code reads. Never a value */
export function keysFacts(env) {
  const set = Object.keys(env || {}).filter((k) => typeof env[k] === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) && !CF_SYSTEM.has(k));
  return { set: set.length, unused: set.filter((k) => !READ_KEYS.has(k)).sort() };
}

const DOMAIN_TTL = 6 * 3600e3;
const domainCache = new Map();
const TIMEOUT = 6000;

const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 8) : null);
const BY = { 'github:push': 'push', deploy_hook: 'publish' };

async function getJson(fetchImpl, url, headers = {}) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Cloudflare's production builds → { tracking, live, active, failed }: times, short commits and how each started */
export function pagesFrom(results) {
  const s = summarizeDeploys(results);
  const raw = new Map((results || []).map((d) => [d.id, d]));
  const view = (v) => {
    if (!v) return null;
    const d = raw.get(v.id) || {};
    return { at: v.at, endedAt: v.endedAt, commit: short(d.deployment_trigger?.metadata?.commit_hash), by: BY[d.deployment_trigger?.type] || 'other' };
  };
  return { tracking: true, live: view(s.live), active: view(s.active), failed: view(s.failed) };
}

/** What Cloudflare did with main's newest commit: the newest of its production builds decides */
export function buildOf(sha, results) {
  const mine = (results || [])
    .filter((d) => (d.environment || 'production') === 'production' && short(d.deployment_trigger?.metadata?.commit_hash) === sha)
    .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  if (!mine) return 'none';
  const st = mine.latest_stage || {};
  if (['failure', 'canceled'].includes(st.status)) return 'failed';
  if (st.name === 'deploy' && st.status === 'success') return 'live';
  return 'building';
}

/** One RDAP answer → { registrar, expires, ns, transferredAt } */
export function rdapFacts(j) {
  const event = (k) => (j.events || []).find((e) => e.eventAction === k)?.eventDate || null;
  const reg = (j.entities || []).find((e) => (e.roles || []).includes('registrar'));
  const fn = reg?.vcardArray?.[1]?.find((x) => x[0] === 'fn')?.[3] || null;
  return {
    registrar: fn,
    expires: event('expiration'),
    ns: (j.nameservers || []).map((n) => String(n.ldhName || '').toLowerCase().replace(/\.$/, '')).filter(Boolean).sort(),
    transferredAt: event('transfer'),
  };
}

async function domainFacts(name, fetchImpl, now) {
  const hit = domainCache.get(name);
  if (hit && now - hit.at < DOMAIN_TTL) return hit.facts;
  const base = RDAP[name.split('.').pop()];
  if (!base) return { error: 'No registry to ask' };
  try {
    const facts = rdapFacts(await getJson(fetchImpl, base + name, { Accept: 'application/rdap+json' }));
    domainCache.set(name, { at: now, facts });
    return facts;
  } catch (e) {
    // A registry that doesn't answer keeps the last good reading, however old
    return hit ? { ...hit.facts, stale: true } : { error: e.message };
  }
}

export async function hostingFacts(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const pagesRead = (async () => {
    if (!env.CF_ACCOUNT_ID || !env.CF_PAGES_TOKEN) return { results: null, pages: { tracking: false } };
    const j = await getJson(fetchImpl, `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${PAGES_PROJECT}/deployments?per_page=10&env=production`,
      { Authorization: `Bearer ${env.CF_PAGES_TOKEN}` });
    if (!j.success || !Array.isArray(j.result)) throw new Error(j.errors?.[0]?.message || 'no builds in the answer');
    return { results: j.result, pages: pagesFrom(j.result) };
  })();
  const githubRead = (async () => {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'soard-admin' };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const url = `https://api.github.com/repos/${REPO}/commits/main`;
    let c;
    try {
      c = await getJson(fetchImpl, url, headers);
    } catch (e) {
      // The repo is public: a key that can't see it (one made before the move to SOARD's organization) still reads it without the key
      if (!headers.Authorization || !/HTTP (401|403|404)/.test(e.message)) throw e;
      const { Authorization, ...open } = headers;
      c = await getJson(fetchImpl, url, open);
    }
    const message = String(c.commit?.message || '');
    return { sha: short(c.sha), at: c.commit?.committer?.date || c.commit?.author?.date || null, skip: /\[(skip ci|ci skip|skip actions|actions skip)\]/i.test(message) };
  })();
  const [p, g, ...d] = await Promise.allSettled([pagesRead, githubRead, ...DOMAINS.map((n) => domainFacts(n, fetchImpl, now))]);
  const results = p.status === 'fulfilled' ? p.value.results : null;
  const github = g.status === 'fulfilled' ? g.value : { error: g.reason?.message || 'GitHub didn’t answer' };
  if (!github.error && github.sha && results) github.build = buildOf(github.sha, results);
  return {
    keys: keysFacts(env),
    pages: p.status === 'fulfilled' ? p.value.pages : { tracking: true, error: p.reason?.message || 'Cloudflare didn’t answer' },
    github,
    domains: Object.fromEntries(DOMAINS.map((n, i) => [n, d[i].status === 'fulfilled' ? d[i].value : { error: d[i].reason?.message || 'no answer' }])),
  };
}

/** For tests: forget the domains read so far */
export const clearHostingCache = () => domainCache.clear();
