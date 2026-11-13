/**
 * Kit Signals on a donor's page (Admin → Donors & Partners)
 * ===========================================================================
 * Peter, Nov 13 2026: "can we get kit signals information on the donor profile too?" Kit's Subscriber Signals adds
 * what Kit finds about a subscriber from public sources (help.kit.com, "Subscriber Signals: getting started"). It's
 * read live from Kit through the site's own key (KIT_API_KEY, SOARD's Kit account), each time a page opens; nothing is
 * kept here. Kit has it only on its Creator Pro plan with Signals turned on, and finds something for about a quarter
 * of a list; when it has nothing, the page says why (the plan Kit reports, or nothing found for them).
 *
 * What a donor's page shows (everyone on staff sees it): their work (job title), LinkedIn, their social profiles and
 * reach, and two household facts that speak to giving (income, home ownership). Kit's other household facts (age,
 * gender, marital status, children, household size, education) are personal and say little about giving, so they're
 * never asked for here. Never for anyone on the team (a staff member who gives), and never for an organization (Kit
 * knows people).
 */
import { kitConfigured, kitFetch } from './_kit.js';
import { subjectOf, teamOf, searchable, staffDirectory } from './_donor-timeline.js';
import { normEmail } from './_board-roles.js';

const HOUR = 3600e3;
// The Kit Fields this page reads, and nothing else Kit has (see above)
export const SHOWN = ['job_title', 'social_reach', 'household_income', 'home_ownership',
  'linkedin_username', 'linkedin_bio', 'linkedin_connections', 'linkedin_followers',
  'instagram_username', 'instagram_followers', 'twitter_username', 'twitter_followers',
  'youtube_username', 'youtube_subscribers', 'tiktok_username', 'tiktok_followers', 'twitch_username', 'twitch_followers'];
const SOCIAL = [
  ['linkedin', 'LinkedIn', (u) => `https://www.linkedin.com/in/${u}`, 'linkedin_connections', 'connections'],
  ['instagram', 'Instagram', (u) => `https://www.instagram.com/${u}`, 'instagram_followers', 'followers'],
  ['twitter', 'X', (u) => `https://x.com/${u}`, 'twitter_followers', 'followers'],
  ['youtube', 'YouTube', (u) => `https://www.youtube.com/@${u}`, 'youtube_subscribers', 'subscribers'],
  ['tiktok', 'TikTok', (u) => `https://www.tiktok.com/@${u}`, 'tiktok_followers', 'followers'],
  ['twitch', 'Twitch', (u) => `https://www.twitch.tv/${u}`, 'twitch_followers', 'followers'],
];
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fail = (status, message) => Object.assign(new Error(message), { status });

let plan = null; // { at, type } SOARD's Kit plan, as Kit says it (kept an hour)
async function kitPlan(env, now) {
  if (plan && now - plan.at < HOUR) return plan.type;
  const res = await kitFetch(env, '/account');
  const body = await res.json().catch(() => ({}));
  const type = res.ok ? clean(body?.account?.plan?.plan_type || body?.account?.plan_type) || null : null;
  plan = { at: now, type };
  return type;
}
/** A Kit plan's name in words ("creator_pro" → Creator Pro) */
export const planWords = (type) => clean(String(type || '').replace(/_/g, ' ')).replace(/\b\w/g, (c) => c.toUpperCase()) || 'unknown';

/** Kit's answer as the page shows it: only SHOWN, a username only as a username, numbers as numbers */
export function signalsOf(kitFields) {
  const f = kitFields && typeof kitFields === 'object' ? kitFields : {};
  const text = (k, max = 300) => { const v = clean(f[k]); return v ? v.slice(0, max) : null; };
  const num = (k) => { const n = Number(String(f[k] ?? '').replace(/[, ]/g, '')); return Number.isFinite(n) && n >= 0 && String(f[k] ?? '') !== '' ? Math.round(n) : null; };
  const user = (k) => { const u = clean(f[k]).replace(/^@/, ''); return /^[A-Za-z0-9._-]{1,100}$/.test(u) ? u : null; };
  const social = SOCIAL.map(([key, label, url, countKey, countWord]) => {
    const u = user(`${key}_username`);
    // LinkedIn says connections, else followers
    const [count, word] = num(countKey) != null ? [num(countKey), countWord] : key === 'linkedin' && num('linkedin_followers') != null ? [num('linkedin_followers'), 'followers'] : [null, countWord];
    return u || count != null ? { key, label, username: u, url: u ? url(u) : null, count, countWord: word } : null;
  }).filter(Boolean);
  const out = {
    jobTitle: text('job_title', 160),
    linkedinBio: text('linkedin_bio', 600),
    socialReach: num('social_reach'),
    income: text('household_income', 80),
    homeOwnership: text('home_ownership', 80),
    social,
  };
  return Object.values(out).some((v) => (Array.isArray(v) ? v.length : v != null)) ? out : null;
}

/**
 * A donor's Kit Signals → { state: 'ok', signals, email } | { state: 'none' | 'off' | 'plan' | 'skipped', note } |
 * { state: 'error', note }. ref: a person's page address (a Zeffy contact id or g:<payment>)
 */
export async function signalsFor(env, ref, { now = Date.now() } = {}) {
  if (!kitConfigured(env)) return { state: 'off', note: 'Kit isn’t connected' };
  const subject = await subjectOf(env, ref, { now });
  if (!subject) throw fail(404, 'No donor by that link');
  if (subject.kind !== 'person') return { state: 'skipped', note: 'Kit Signals are about people' };
  const look = searchable(subject, teamOf(await staffDirectory(env.DB)));
  if (look.team) return { state: 'skipped', note: `${subject.name} is on the team` };
  const emails = look.emails.slice(0, 5);
  if (!emails.length) return { state: 'none', note: 'No email to find them by in Kit' };
  try {
    const res = await kitFetch(env, `/subscribers?${new URLSearchParams({ email_address: emails.join(','), status: 'all', per_page: '10' })}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { state: 'error', note: `Kit answered ${res.status}` };
    const subs = (body.subscribers || []).filter((s) => emails.includes(normEmail(s.email_address)));
    if (!subs.length) return { state: 'none', note: 'They aren’t in Kit' };
    // Each of their records in Kit, the first that Kit has Signals for
    let refused = false;
    for (const s of subs.slice(0, 3)) {
      const r = await kitFetch(env, `/subscribers/${encodeURIComponent(s.id)}?include=kit_fields`);
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { refused = true; continue; }
      const signals = signalsOf(b?.subscriber?.kit_fields);
      if (signals) return { state: 'ok', signals, email: normEmail(s.email_address) };
    }
    // Nothing: because the plan hasn't Signals, or because Kit found nothing about them
    const type = await kitPlan(env, now).catch(() => null);
    if (type && !/pro/i.test(type)) return { state: 'plan', plan: planWords(type), note: `Kit Signals needs Kit’s Creator Pro plan. SOARD’s Kit is on ${planWords(type)}.` };
    return { state: 'none', note: refused ? 'Kit didn’t give their Signals' : 'Kit found nothing about them (it does for about a quarter of a list)' };
  } catch (e) {
    return { state: 'error', note: `Kit didn’t answer: ${e.message}` };
  }
}
