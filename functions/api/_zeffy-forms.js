/**
 * SOARD's Zeffy forms, for the admin's Zeffy form dropdowns (public/admin/zeffy-forms.js)
 * ===========================================================================
 * Wherever admin asks for a Zeffy link (a kid's fundraising link, an event's tickets, the gala's and the golf
 * tournament's, the Advisory Board's campaign and a hosted fundraiser's page), a dropdown lists the forms Zeffy has
 * and picking one fills in its link. Zeffy stays the record: the list is read fresh each time and never kept.
 *
 * Read by /api/zeffy-forms (staff) and by /api/advisory-admin?zeffyForms=1 (whoever runs the Advisory Board, who
 * signs in as a board member and can't reach the staff routes).
 *
 * Each form: { id, title, url, kind, open, created }
 *   kind   donation | tickets | peer | auction | raffle | membership | shop  (the dropdown groups by it)
 *   open   false for an archived, closed or draft form, or one whose end date has passed (a past event Zeffy still calls
 *          active): the dropdown shows one only when it's the link already chosen
 *   ended  true when it's the end date that closed it, so the dropdown can say "ended"
 * A deleted form, or one with no public page, isn't listed.
 */

import { zeffyGet } from './_zeffy.js';

const MAX_PAGES = 20; // 2,000 forms: far past what SOARD has
// Any status but an open one: Zeffy's docs don't list them, so every word for not taking gifts is here
const STOPPED = /draft|closed|archiv|delet|inactive|ended|expired|cancel|unpublish|pause|complet|finish|past|disabled|suspend/i;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** What a Zeffy campaign is, in the groups the dropdown shows */
export function kindOf(c) {
  const cat = String(c?.category || '').toLowerCase().replace(/-/g, '_');
  if (cat === 'peer_to_peer') return 'peer';
  if (cat === 'sweepstakes') return 'raffle';
  if (['auction', 'raffle', 'membership', 'shop'].includes(cat)) return cat;
  if (c?.type === 'ticketing' || cat === 'event') return 'tickets';
  return 'donation';
}

/** One Zeffy campaign as the dropdown needs it, or null when it can't be linked to */
export function formOf(c, now = Date.now()) {
  const url = clean(c?.url);
  if (!c?.id || c.deleted_at || !/^https:\/\/[^/\s]+\/\S*$/i.test(url)) return null;
  const stopped = !!c.is_archived || STOPPED.test(String(c.status || ''));
  const ended = !stopped && Number(c.end_date) > 0 && Number(c.end_date) * 1000 < now;
  return {
    id: String(c.id),
    title: clean(c.title) || 'Untitled form',
    url,
    kind: kindOf(c),
    open: !stopped && !ended,
    ...(ended ? { ended: true } : {}),
    created: Number(c.created) || 0,
  };
}

/** Every form in SOARD's Zeffy, newest first. Throws { status: 503 } with plain words when Zeffy can't be read */
export async function zeffyForms(env, fetchImpl = fetch, now = Date.now()) {
  if (!env.ZEFFY_API_KEY) throw Object.assign(new Error('Zeffy isn’t connected: ZEFFY_API_KEY is missing in Cloudflare.'), { status: 503 });
  const out = [];
  let after = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await zeffyGet(env, '/campaigns', { limit: 100, starting_after: after }, fetchImpl);
      for (const c of r?.data || []) {
        const f = formOf(c, now);
        if (f) out.push(f);
      }
      if (!r?.has_more || !r.next_cursor) return out.sort((a, b) => b.created - a.created);
      after = r.next_cursor;
    }
  } catch (e) {
    // Zeffy's own refusal (a 401 for a bad key, say) must not read as the person's sign-in running out
    console.error('[zeffy-forms]', e?.status || '', e?.message || e);
    throw Object.assign(new Error(e?.status === 429 ? 'Zeffy is busy. Its forms show again in a minute.' : 'Zeffy didn’t answer, so its forms can’t be listed just now.'), { status: 503 });
  }
  throw Object.assign(new Error('Zeffy has more forms than the site reads at once.'), { status: 503 });
}
