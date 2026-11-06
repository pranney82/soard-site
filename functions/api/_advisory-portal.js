/**
 * What the Advisory Board's page gets (GET /api/advisory-portal)
 * ===========================================================================
 * An allow-list, built here from the advisors' own tables and public things.
 * It never calls the board's portalData and nothing passes through from it.
 * Dollars appear only under `fundraise`, which the page shows only on Fundraise:
 * no goal bar near a reveal or a kid (the reveal belongs to the family).
 */

import {
  getSettings, advisorCards, leadCard, currentAsk, answersTo, listWishes, introsBy, listHosted, termOf, canRenew, listDocs, signatures,
  INTRO_STATUSES, INTRO_HELP, GROUP_ADDRESS, ensureAdvisory,
} from './_advisory.js';
import { advisoryBits } from './_board.js';
import { todayEastern } from './_reveals.js';
import { orgFacts } from './_org-facts.js';
import { goalNow } from './_advisory-money.js';
import { kidCard } from './_advisory-sponsor.js';
import { meetingsFor } from './_advisory-meetings.js';
import { seedOnce } from './_advisory-seed.js';

const FUNDRAISE_KINDS = ['pitch', 'post', 'sponsor', 'matching', 'hosting'];
const docView = (d, sig, mine) => ({
  id: d.id, kind: d.kind, title: d.title, body: d.body, url: d.url || '', version: d.version || 1, files: d.files || [],
  ...(d.kind === 'agreement' ? { signedByMe: mine ? sig?.[d.id]?.[mine] || null : null } : {}),
});

export async function advisoryPortalData(env, who, { now = Date.now() } = {}) {
  const { DB } = env;
  await ensureAdvisory(DB);
  await seedOnce(DB);
  const today = todayEastern(now);
  const settings = await getSettings(DB);
  const mine = who.answers ? who.slug : null;
  const [people, lead, ask, wishes, intros, hosted, docs, sigs, bits, org, meetings] = await Promise.all([
    advisorCards(DB), leadCard(DB, settings), currentAsk(DB), listWishes(DB), mine ? introsBy(DB, mine) : [], listHosted(DB),
    listDocs(DB), signatures(DB), advisoryBits(env, { now }), orgFacts(env).catch(() => null), meetingsFor(env, who, { now }),
  ]);
  const myAnswer = ask && mine ? (await answersTo(DB, ask.id)).find((a) => a.slug === mine) || null : null;
  const term = mine ? await termOf(DB, mine, settings) : null;
  const shared = docs.filter((d) => d.shared !== false);
  const agreement = shared.find((d) => d.kind === 'agreement') || null;
  const signed = agreement && mine ? sigs[agreement.id]?.[mine] : null;
  // Signed once a term: on these words, since their term began or they last renewed
  const since = term?.renewedOn || term?.started || '';
  const todos = [
    ...(agreement && mine && (!signed || String(signed.at).slice(0, 10) < since || signed.version !== (agreement.version || 1)) ? [{ kind: 'sign', id: agreement.id, title: `Sign the ${agreement.title}` }] : []),
    ...(term && canRenew(term, today) ? [{ kind: 'renew', title: 'Renew for another year', ends: term.ends }] : []),
  ];
  return {
    ok: true,
    me: { kind: who.kind, name: who.name || '', slug: who.slug || '', runs: who.runs, answers: who.answers },
    today,
    term: term ? { ...term, canRenew: canRenew(term, today) } : null,
    lead,
    groupEmail: GROUP_ADDRESS,
    meetings,
    ask: ask ? { id: ask.id, title: ask.title, body: ask.body, link: ask.link || '', mine: myAnswer ? { answer: myAnswer.answer, note: myAnswer.note } : null } : null,
    todos,
    makeover: await kidCard(env, settings, bits),
    coming: { reveals: bits.reveals, events: bits.events, hosted: hosted.filter((h) => h.status === 'approved' && h.date >= today).map(({ id, title, date, where, giveUrl }) => ({ id, title, date, where, giveUrl: giveUrl || '' })) },
    rooms: bits.rooms,
    wishes: wishes.map(({ id, title, detail }) => ({ id, title, detail })),
    intros: intros.map(({ id, name, company, status, note, at, updatedAt }) => ({ id, name, company, status, note: note || '', at, updatedAt })),
    introStatuses: INTRO_STATUSES,
    introHelp: INTRO_HELP,
    hosted: mine ? hosted.filter((h) => h.slug === mine).map(({ id, title, status, when, note }) => ({ id, title, status, when, note: note || '' })) : [],
    fundraise: await goalNow(env, settings, { slug: mine }),
    share: shared.filter((d) => FUNDRAISE_KINDS.includes(d.kind)).map((d) => docView(d)),
    people,
    papers: shared.filter((d) => !FUNDRAISE_KINDS.includes(d.kind)).map((d) => docView(d, sigs, mine)),
    filings: bits.filings,
    org,
  };
}
