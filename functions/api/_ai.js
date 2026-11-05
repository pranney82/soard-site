/**
 * Every Workers AI call goes through the site's AI Gateway
 * ===========================================================================
 *   env.AI.run(MODEL, input, viaGateway('mail-sweep'))
 *
 * The gateway (Cloudflare → AI → AI Gateway → soard-site) counts this site's AI
 * apart from the store's, which shares the Cloudflare account, and caps it an
 * hour at a time if something ever loops. A call past the cap fails the way any
 * AI call can fail, and every caller already handles that.
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

export function viaGateway(feature) {
  return {
    gateway: { id: GATEWAY_ID, collectLog: false, metadata: { feature } },
    tags: [`${GATEWAY_ID}:${feature}`],
  };
}
