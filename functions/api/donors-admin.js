/**
 * /api/donors-admin — Admin → Donors & Partners (public/admin/donors.js)
 * ===========================================================================
 * Behind Cloudflare Access like every admin route: staff only (a board member's sign-in reaches only the board
 * page's routes). Gifts and contacts come from the site's list of Zeffy payments (./_donors.js) and are changed in
 * Zeffy; what only the site knows (which organization a name is, the same person, Keep anonymous: ./_donor-crm.js) is
 * changed here, private, never on the website.
 *
 * GET                       → { success, people, needs, thanks, staff, me, payments, windowAt, filledAt, … }
 *                             people and organizations (each with its owner), how many need a person, how many gifts
 *                             wait for a thank-you, the team to pick an owner from, and who's signed in
 * GET ?donor=<ref>          → { success, donor, gifts, gaveFor, companies, also, keepAnonymous, kit } | { success, org }
 *                             ref: a Zeffy contact id, or g:<a payment of theirs> for a donor Zeffy has no contact for
 *                             (never an email in a link); kit: { state } | { none: true } | { error } | null (no email)
 * GET ?org=<p:slug|o:id>    → { success, donor, gifts, names, people, needs, onSite, level, keepAnonymous, … }
 * GET ?giving=<p:slug>      → { success, gifts, total, cents12, latest, suggest }   a partner's giving, for its card
 * GET ?needs=1              → { success, items }             what needs a person
 * GET ?thanks=1             → { success, items, staff }      gifts waiting for a thank-you (./_donor-thanks.js)
 * GET ?orgs=1               → { success, orgs }              every organization, to link a name to
 * POST { find: <text> }     → { success, names }             Zeffy names to link to an organization (posted: it can be an email)
 * POST { findPeople, except } → { success, people }          people to join with a person ("Same person as…")
 * GET ?gift=<payment id>    → { success, ref } | { success, org }   which donor a gift is (the MAJOR GIFT Slack link)
 * GET ?counts=1             → { success, checksWaiting }     the Checks tab's count, on whichever tab is open
 * POST { act, … }           → { success, … }                 a change (./_donor-crm.js act): links, Keep anonymous, the
 *                             same person, owner, notes (note-add, note-edit, note-delete), thank-yous (thanks)
 * A donor's page (?donor, ?org) also carries { owner, notes, history, staff }, and each gift its thank-you
 */
import { listView, needsView, thanksView, personView, orgView, orgSummary, orgsList, findNames, findPeople, giftOwner, act } from './_donor-crm.js';
import { kitFindSubscribers, kitConfigured } from './_kit.js';
import { checksFacts } from './_check-gifts.js';

const ok = (body = {}) => Response.json({ success: true, ...body });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });

export async function onRequestGet({ env, request, data }) {
  if (!env.DB) return fail('D1 binding missing', 503);
  const q = new URL(request.url).searchParams;
  try {
    if (q.get('counts')) return ok({ checksWaiting: (await checksFacts(env.DB).catch(() => null))?.waiting || 0 });
    if (q.get('needs')) return ok(await needsView(env));
    if (q.get('thanks')) return ok(await thanksView(env));
    if (q.get('giving')) return ok(await orgSummary(env, q.get('giving')));
    if (q.get('orgs')) return ok(await orgsList(env));
    if (q.get('gift')) {
      const o = await giftOwner(env, q.get('gift'));
      return o ? ok(o) : fail('That gift isn’t in the donor list yet. It comes in within 15 minutes of reaching Zeffy.', 404);
    }
    if (q.get('org')) {
      const v = await orgView(env, q.get('org'));
      if (v?.moved) return ok({ org: v.moved });
      return v ? ok(v) : fail('No organization by that link. It may have been taken out, or merged into another partner.', 404);
    }
    if (q.get('donor')) {
      const v = await personView(env, q.get('donor'));
      if (!v) return fail('No donor by that link. Their gifts may have moved to another donor in Zeffy.', 404);
      // Every gift of theirs counts for an organization: that's where they are
      if (v.org) return ok({ org: v.org });
      let kit = null;
      if (v.donor.email && kitConfigured(env)) {
        const r = await kitFindSubscribers(env, [v.donor.email]);
        kit = !r.ok ? { error: 'Kit didn’t answer' } : r.byEmail.has(v.donor.email) ? { state: r.byEmail.get(v.donor.email).state } : { none: true };
      }
      return ok({ ...v, kit });
    }
    return ok({ ...(await listView(env)), me: String(data?.userEmail || '').toLowerCase() || null });
  } catch (e) {
    console.error('[donors-admin]', e.message);
    return fail('The site didn’t answer. Try again in a minute.', 500);
  }
}

export async function onRequestPost({ env, request, data }) {
  if (!env.DB) return fail('D1 binding missing', 503);
  let body;
  try { body = await request.json(); } catch { return fail('Send JSON'); }
  try {
    if (typeof body?.find === 'string') return ok(await findNames(env, body.find));
    if (typeof body?.findPeople === 'string') return ok(await findPeople(env, body.findPeople, { except: body.except || null }));
    return ok(await act(env, body, data?.userEmail || null));
  } catch (e) {
    if (e.status && e.status < 500) return fail(e.message, e.status);
    console.error('[donors-admin] post', e.message);
    return fail('The site didn’t save that. Try again in a minute.', 500);
  }
}
