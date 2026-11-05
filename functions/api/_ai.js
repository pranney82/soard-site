/**
 * Every Workers AI call goes through the site's AI Gateway
 * ===========================================================================
 *   env.AI.run(MODEL, input, viaGateway('mail-sweep'))
 *
 * The gateway (Cloudflare → AI → AI Gateway → soard-site) counts this site's AI
 * apart from the store's, which shares the Cloudflare account, and caps it if
 * something ever loops: calls an hour for the site, dollars a day for the site
 * and for each feature, so one job running away can't stop the others. A call
 * past a cap throws, and aiCapped says that's what it was. A job working through
 * a queue waits (no try spent, a rest of AI_REST_MS) instead of recording the
 * email or paper as read, because the cap lifts by itself and the work is fine.
 *
 * `feature` is the name shown beside the numbers, so a jump in cost points at
 * what made it. It's the only thing kept: family emails, W-9s and board papers
 * go through these calls, so nothing is logged. The gateway's own log setting is
 * off, and collectLog says so again on each call, so a dashboard switch alone
 * can't start saving them. Caching stays off too: a re-read has to really read.
 *
 * tests/ai-gateway.test.mjs fails on a call that leaves this out.
 */

const GATEWAY_ID = 'soard-site';

/** How long a job leaves the AI alone after a cap turned it away: refused calls cost nothing, what comes before them can */
export const AI_REST_MS = 15 * 60 * 1000;
/** What a row waiting on the cap says */
export const AI_WAIT_NOTE = 'Waiting: Workers AI reached its spending cap, and this goes on when it lifts';

/** Cloudflare turned the call away at a cap: 2003 the gateway's calls an hour, 2045 a spend limit */
export const aiCapped = (err) => /^\s*(2003|2045):/.test(String(err?.message || ''));

export function viaGateway(feature) {
  return {
    gateway: { id: GATEWAY_ID, collectLog: false, metadata: { feature } },
    tags: [`${GATEWAY_ID}:${feature}`],
  };
}
