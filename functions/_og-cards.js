/**
 * A page's share card address, for server code that changes a page's preview
 * on the way out (/live/ during a reveal, the Control Room's link). The build
 * writes every page's card address to /og/index.json (src/integrations/og-cards.mjs);
 * the address carries the card's version, so apps that keep previews fetch a
 * changed card again.
 */

let cards = null; // per worker: a new deploy starts new workers, with its own list

/** The card address for a page ("/live/amari/" → "/og/live/amari.jpg?v=<its fingerprint>"), or null */
export async function cardFor(context, page) {
  try {
    if (!cards) {
      const res = await context.env.ASSETS.fetch(new Request(new URL('/og/index.json', context.request.url)));
      if (!res.ok) return null;
      cards = await res.json();
    }
    const card = cards[page];
    return (typeof card === 'string' ? card : card?.url) || null;
  } catch {
    return null;
  }
}
