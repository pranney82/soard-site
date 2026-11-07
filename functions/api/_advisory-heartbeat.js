/**
 * The Advisory Board's heartbeat, from the board's (./_board.js maybeRunBoard). Each step has its own try: one failing holds up nothing.
 *   every 5 minutes at most, with emails on, advisory@soardcharity.com kept in step with People → Advisory (./_board-group.js)
 *   every 15 minutes, what's been raised, from Zeffy (./_advisory-money.js), and the kid's pledge kept equal to it
 *   invites' replies and drift (./_advisory-meetings.js)
 *   once a week at most, a nudge to whoever runs the group when something's been waiting (./_advisory-mail.js)
 * Never throws.
 */

import { maybeSyncAdvisoryGroup } from './_board-group.js';
import { getSettings, ensureAdvisory } from './_advisory.js';
import { maybeReadMoney } from './_advisory-money.js';
import { keepPledge } from './_advisory-sponsor.js';
import { maybeNudgeLead, sendGiftNote, noticeGoal, sendGoalNote } from './_advisory-mail.js';
import { maybeSyncAdvisoryMeetings } from './_advisory-meetings.js';

export async function maybeRunAdvisory(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const step = async (name, fn) => { try { return await fn(); } catch (e) { console.error(`[advisory] ${name}`, e?.message || e); return null; } };
  // advisory@ fills once emails are on: until then nobody outside SOARD hears anything through it, and it can be tested quietly
  await step('group', async () => { await ensureAdvisory(env.DB); return (await getSettings(env.DB)).emails ? maybeSyncAdvisoryGroup(env, { fetchImpl, now }) : null; });
  const money = await step('money', () => maybeReadMoney(env, { fetchImpl, now }));
  if (money) {
    await step('pledge', () => keepPledge(env, money.settings, money.raised, { now }));
    if (money.settings.emails) for (const [slug, n] of Object.entries(money.fresh)) await step('gift note', () => sendGiftNote(env, slug, n));
    if (money.reachedGoal) {
      await step('goal', () => noticeGoal(env, money.settings, { raised: money.raised }));
      await step('goal note', () => sendGoalNote(env, money.settings));
    }
  }
  await step('meetings', () => maybeSyncAdvisoryMeetings(env, { fetchImpl, now }));
  // A paper the board took back in a way its save doesn't catch (a new staff-only file, a deleted paper)
  await step('papers', async () => { const { boardPapers } = await import('./_advisory-portal.js'); return boardPapers(env.DB, await getSettings(env.DB)); });
  await step('nudge', () => maybeNudgeLead(env, { now }));
}
