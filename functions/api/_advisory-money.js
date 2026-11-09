/**
 * What the Advisory Board has raised, from Zeffy
 * ===========================================================================
 * Zeffy stays the record. Every 15 minutes (./_advisory-heartbeat.js) this reads
 * the group's peer-to-peer campaign, each advisor's page under it, any hosted
 * fundraiser's page and any gift credited to the group, from the term's first
 * day, and keeps the sum in board_state. Nothing is typed here: a check goes into
 * Zeffy as a manual entry on the campaign, so it counts once and has a receipt.
 *
 * A Payment carries campaign_id (its page), parent_campaign_id (the campaign's
 * main page) and team_id, per Zeffy's published API. A fundraiser's page has no
 * owner in the API (creator_user_id is null for them), so a page is matched to
 * its advisor by the name in its title, or by hand on Run it when that can't.
 * A gift on the main page counts for the group and for no one person.
 *
 * Refunds (pending ones too) and lost disputes come off as Zeffy reports them.
 * A credit keeps only which payment and who, so its amount stays Zeffy's.
 * Dollar figures go to the Fundraise page and to whoever runs the group: never
 * beside a kid or a reveal, and one advisor never sees another's number.
 */

import { zeffyGet } from './_zeffy.js';
import { readState, writeState, activeAdvisors, normEmail } from './_board-roles.js';
import { ensureAdvisory, saveSettings, listHosted, getSettings } from './_advisory.js';
import { nameKey } from '../../public/admin/partners-shared.js';
import { sameForm } from '../../public/admin/zeffy-links.js';

const KEY = 'advisory-money';
const EVERY_MS = 15 * 60 * 1000;
const MAX_PAGES = 80;
const unix = (date) => Math.floor(Date.parse(`${date}T05:00:00Z`) / 1000);
const DAY_S = 86400;
const linkKey = (u) => String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
// A Zeffy link matches its campaign whatever its language, embed or tracking (the admin's dropdowns use the same rule):
// Zeffy's API gives campaign links with no language, while a link copied from Zeffy has one
export const sameLink = (a, b) => sameForm(a, b) || (!!linkKey(a) && linkKey(a) === linkKey(b));
const err = (message, status = 400) => Object.assign(new Error(message), { status });

/** What a payment counts for, in cents, once refunds and disputes are taken off */
export function centsOf(p) {
  if (!p || String(p.status || '').toLowerCase() !== 'succeeded') return 0;
  if (p.metadata?.soardSelfTest === true || p.refund_status === 'full' || p.dispute?.status === 'lost') return 0;
  const refunded = (p.refunds || []).filter((r) => r?.status !== 'failed').reduce((t, r) => t + (Number(r?.amount) || 0), 0);
  return Math.max(0, (Number(p.amount) || 0) - refunded);
}

async function every(env, path, params, fetchImpl) {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await zeffyGet(env, path, { ...params, limit: 100, starting_after: after }, fetchImpl);
    out.push(...(r?.data || []));
    if (!r?.has_more || !r.next_cursor) return out;
    after = r.next_cursor;
  }
  // Part of an answer is no answer: the last whole sum stands
  throw new Error('Zeffy had more than this read can hold');
}

/** The advisor a page's title names: exactly one, or none */
export function advisorIn(title, advisors) {
  const t = nameKey(title);
  const on = advisors.filter((a) => { const k = nameKey(a.name); return k && t.includes(k); });
  return on.length === 1 ? on[0].slug : '';
}

/**
 * The whole picture from Zeffy's answers (pure, so it can be tested without Zeffy).
 * → { cents, byAdvisor, gifts, pages, unmatched, ids }
 */
export function tally({ campaignId, payments, pages, credits, hostedIds = {}, advisors, titles = {} }) {
  const byAdvisor = {};
  const gifts = {};
  const seen = new Map();
  const add = (slug, cents, id) => { if (!slug) return; byAdvisor[slug] = (byAdvisor[slug] || 0) + cents; (gifts[slug] ||= []).push(id); };
  const creditOf = new Map(credits.map((c) => [c.payment_id, c.slug || '']));
  let cents = 0;
  const pageIds = new Set(Object.keys(pages));
  for (const p of payments) {
    if (!p?.id || seen.has(p.id)) continue;
    const c = centsOf(p);
    seen.set(p.id, c);
    if (!c) continue;
    const page = String(p.campaign_id || '');
    const under = (!!campaignId && (page === campaignId || String(p.parent_campaign_id || '') === campaignId)) || pageIds.has(page) || page in hostedIds;
    if (!under && !creditOf.has(p.id)) continue;
    cents += c;
    const slug = creditOf.get(p.id) || pages[page] || hostedIds[page] || advisorIn(titles[page] || '', advisors);
    add(slug, c, p.id);
  }
  return { cents, byAdvisor, gifts };
}

/** Read Zeffy and keep the sum. → the saved state. A read that fails keeps the last sum and says so */
export async function readMoney(env, settings, { fetchImpl = fetch, now = Date.now() } = {}) {
  const prev = await readState(env.DB, KEY);
  try {
    const from = unix(settings.termStart);
    const to = unix(settings.termEnd) + DAY_S;
    const [advisors, hosted, credits] = await Promise.all([
      activeAdvisors(env.DB), listHosted(env.DB),
      env.DB.prepare('SELECT payment_id, slug FROM advisory_credits').all().then((r) => r.results || []),
    ]);
    // Every step below has to answer: a read that fails partway keeps the last whole sum (the catch at the end).
    // Every page made since the term began: an advisor's can show its link before its first gift
    const all = await every(env, '/campaigns', {}, fetchImpl);
    const campaigns = all.filter((c) => !(Number(c.created) < from));
    // A hosted fundraiser's page, however its link was pasted, even one made before the term; one not found says so on Run it
    const hostedIds = {};
    const missing = [];
    for (const h of hosted.filter((x) => x.giveUrl)) {
      const c = all.find((x) => sameLink(x.url, h.giveUrl));
      if (c) hostedIds[c.id] = h.slug; else missing.push({ id: h.id, title: h.title, url: h.giveUrl });
    }
    // Every gift in the term, then ours picked out by their own ids: whether Zeffy's campaign filter takes in a main
    // page's fundraisers isn't documented. A credited gift counts only inside the term, like any other
    const list = await every(env, '/payments', { status: 'succeeded', 'created[gte]': from, 'created[lte]': to }, fetchImpl);
    // Pages under the campaign, seen through their gifts, and any made this term naming an advisor
    const titles = Object.fromEntries(campaigns.map((c) => [c.id, c.title || '']));
    const found = new Map();
    for (const p of list) if (p.parent_campaign_id === settings.campaignId && p.campaign_id && p.campaign_id !== settings.campaignId && !p.team_id) found.set(p.campaign_id, null);
    for (const c of campaigns) if (c.id !== settings.campaignId && !c.is_archived && !hostedIds[c.id] && (found.has(c.id) || settings.pages[c.id] || advisorIn(c.title, advisors))) found.set(c.id, c);
    // (a page deleted since has no title to show, and its gifts still count)
    for (const [id, c] of found) if (!c) found.set(id, await zeffyGet(env, `/campaigns/${encodeURIComponent(id)}`, {}, fetchImpl).catch((e) => { if (e.status === 404) return { id }; throw e; }));
    for (const c of found.values()) if (c?.id && c.title) titles[c.id] = c.title;
    const sum = tally({ campaignId: settings.campaignId, payments: list, pages: settings.pages, credits, hostedIds, advisors, titles });
    const pages = [...found.values()].filter((c) => c?.id).map((c) => {
      const slug = settings.pages[c.id] || advisorIn(c.title, advisors);
      return { id: c.id, title: c.title || '', url: c.url || '', slug, cents: list.filter((p) => p.campaign_id === c.id).reduce((t, p) => t + centsOf(p), 0) };
    });
    const before = new Set(prev.seen || []);
    const fresh = {};
    for (const [slug, gifts] of Object.entries(sum.gifts)) { const n = gifts.filter((id) => !before.has(id)).length; if (n && prev.at) fresh[slug] = n; }
    const state = {
      at: new Date(now).toISOString(), cents: sum.cents, byAdvisor: sum.byAdvisor, counts: Object.fromEntries(Object.entries(sum.gifts).map(([k, v]) => [k, v.length])),
      pages, seen: Object.values(sum.gifts).flat(), error: null, goalTerm: prev.goalTerm || null, hostedMissing: missing,
      // What each credited gift comes to now, from Zeffy
      credited: Object.fromEntries(credits.map((c) => [c.payment_id, centsOf(list.find((p) => p.id === c.payment_id))])),
    };
    return { state: await writeState(env.DB, KEY, state), fresh };
  } catch (e) {
    console.error('[advisory-money]', e.message);
    return { state: await writeState(env.DB, KEY, { ...prev, error: e.message, failedAt: new Date(now).toISOString() }), fresh: {} };
  }
}

const carriedOf = (settings) => (settings.carried || []).reduce((t, c) => t + (Number(c.amount) || 0), 0);

/** The Fundraise page's figures: the group's total and, for an advisor, only their own */
export async function goalNow(env, settings, { slug = null } = {}) {
  const m = await readState(env.DB, KEY);
  const page = slug ? (m.pages || []).find((p) => p.slug === slug) : null;
  return {
    goal: settings.goal,
    raised: Math.floor((m.cents || 0) / 100) + carriedOf(settings),
    mine: slug ? Math.floor((m.byAdvisor?.[slug] || 0) / 100) : null,
    gifts: slug ? m.counts?.[slug] || 0 : null,
    pageUrl: page?.url || '',
    groupUrl: settings.campaignUrl || '',
    ready: !!(settings.campaignId || settings.campaignUrl),
    at: m.at || null,
  };
}

/** The campaign's id from its web address, so nobody has to find it: its id, '' when Zeffy doesn't list it, null when Zeffy can't be asked */
export async function campaignFromUrl(env, url, { fetchImpl = fetch } = {}) {
  if (!env.ZEFFY_API_KEY || !url) return null;
  try {
    // A deleted campaign takes no gifts, so it's nobody's to link (a hosted page's past gifts still count: readMoney)
    return (await every(env, '/campaigns', {}, fetchImpl)).find((c) => !c.deleted_at && sameLink(c.url, url))?.id || '';
  } catch { return null; }
}

/** Everything whoever runs the group sees of the money */
export async function moneyView(env, settings) {
  await ensureAdvisory(env.DB);
  const [m, advisors, credits] = await Promise.all([
    readState(env.DB, KEY), activeAdvisors(env.DB),
    env.DB.prepare('SELECT payment_id, slug, note, at, by FROM advisory_credits ORDER BY at DESC').all().then((r) => r.results || []),
  ]);
  const name = (slug) => advisors.find((a) => a.slug === slug)?.name || '';
  return {
    goal: settings.goal,
    raised: Math.floor((m.cents || 0) / 100) + carriedOf(settings),
    carried: settings.carried || [],
    ready: !!settings.campaignId,
    configured: Boolean(env.ZEFFY_API_KEY),
    at: m.at || null,
    error: m.error ? 'Zeffy didn’t answer the last time we looked, so this is the last total we could confirm.' : null,
    byAdvisor: advisors.map((a) => ({ slug: a.slug, name: a.name, dollars: Math.floor((m.byAdvisor?.[a.slug] || 0) / 100), gifts: m.counts?.[a.slug] || 0 })),
    pages: (m.pages || []).map((p) => ({ ...p, who: name(p.slug) })),
    unmatched: (m.pages || []).filter((p) => !p.slug).map(({ id, title, url }) => ({ id, title, url })),
    noPage: advisors.filter((a) => !(m.pages || []).some((p) => p.slug === a.slug)).map((a) => a.name),
    // A hosted fundraiser whose link isn't a Zeffy page we can find: its gifts aren't counting
    hostedMissing: m.hostedMissing || [],
    credits: credits.map((c) => ({ ...c, who: name(c.slug), dollars: Math.floor((m.credited?.[c.payment_id] || 0) / 100) })),
  };
}

/** A donor's gifts this term, found by their email, to credit one to the group */
export async function findGifts(env, settings, { email }, { fetchImpl = fetch } = {}) {
  const e = normEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw err('Type the donor’s email');
  if (!env.ZEFFY_API_KEY) throw err('Zeffy isn’t connected', 503);
  const contacts = await zeffyGet(env, '/contacts', { email: e, limit: 5 }, fetchImpl);
  const out = [];
  for (const c of contacts?.data || []) {
    for (const p of await every(env, '/payments', { contact: c.id, status: 'succeeded', 'created[gte]': unix(settings.termStart) }, fetchImpl)) {
      const cents = centsOf(p);
      if (cents) out.push({ id: p.id, dollars: Math.floor(cents / 100), at: p.created, campaign: String(p.description || '') });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function creditGift(env, settings, { paymentId, slug = '', note = '' }, { by = '', now = Date.now(), fetchImpl = fetch } = {}) {
  await ensureAdvisory(env.DB);
  const id = String(paymentId || '').trim();
  if (!/^[\w-]{6,80}$/.test(id)) throw err('Which gift?');
  await env.DB.prepare('INSERT OR REPLACE INTO advisory_credits (payment_id, slug, note, at, by) VALUES (?, ?, ?, ?, ?)')
    .bind(id, String(slug || '').slice(0, 120) || null, String(note || '').slice(0, 300), new Date(now).toISOString(), by).run();
  await readMoney(env, settings, { fetchImpl, now });
  return moneyView(env, settings);
}
export async function uncreditGift(env, settings, { paymentId }, { fetchImpl = fetch, now = Date.now() } = {}) {
  await ensureAdvisory(env.DB);
  await env.DB.prepare('DELETE FROM advisory_credits WHERE payment_id = ?').bind(String(paymentId || '')).run();
  await readMoney(env, settings, { fetchImpl, now });
  return moneyView(env, settings);
}
/** A Zeffy page matched to its advisor by a person, when its title didn't name one */
export async function matchPage(env, settings, { campaignId, slug }, { fetchImpl = fetch, now = Date.now() } = {}) {
  const id = String(campaignId || '').trim();
  if (!id) throw err('Which page?');
  const pages = { ...settings.pages };
  if (slug) pages[id] = String(slug); else delete pages[id];
  const next = await saveSettings(env.DB, { pages });
  await readMoney(env, next, { fetchImpl, now });
  return moneyView(env, next);
}

/** Heartbeat. → { fresh: { slug: gifts new on their page }, reachedGoal } when it read, else null. Never throws */
export async function maybeReadMoney(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    if (!env.DB || !env.ZEFFY_API_KEY) return null;
    await ensureAdvisory(env.DB);
    const settings = await getSettings(env.DB);
    if (!settings.campaignId) return null;
    const m = await readState(env.DB, KEY);
    // (a failed read waits its turn too: Zeffy down mustn't be asked every heartbeat)
    if (now - Math.max(Date.parse(m.at || '') || 0, Date.parse(m.failedAt || '') || 0, Date.parse(m.triedAt || '') || 0) < EVERY_MS) return null;
    // Written first: a read cut off by the platform's time limit still waits its turn
    await writeState(env.DB, KEY, { ...m, triedAt: new Date(now).toISOString() });
    const { state, fresh } = await readMoney(env, settings, { fetchImpl, now });
    const raised = Math.floor((state.cents || 0) / 100) + carriedOf(settings);
    // Once a term: the next term has its own goal to reach
    const reachedGoal = !state.error && raised >= settings.goal && state.goalTerm !== settings.termStart;
    if (reachedGoal) await writeState(env.DB, KEY, { ...state, goalTerm: settings.termStart });
    return { fresh, reachedGoal, raised, settings };
  } catch (e) {
    console.error('[advisory-money]', e.message);
    return null;
  }
}
