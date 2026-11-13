/**
 * /api/donors-admin — Admin → Donors & Partners (public/admin/donors.js)
 * ===========================================================================
 * Behind Cloudflare Access like every admin route: staff only (a board member's sign-in reaches only the board
 * page's routes). Gifts and contacts come from the site's list of Zeffy payments (./_donors.js) and are changed in
 * Zeffy; what only the site knows (which organization a name is, the same person, Keep anonymous: ./_donor-crm.js) is
 * changed here, private, never on the website.
 *
 * GET                       → { success, people, needs, thanks, thanksOwners, staff, me, payments, windowAt, filledAt, … }
 *                             people and organizations (each with its owner), how many need a person, how many gifts
 *                             wait for a thank-you, the team to pick an owner from, and who's signed in
 * GET ?donor=<ref>          → { success, donor, gifts, gaveFor, companies, also, keepAnonymous, kit } | { success, org }
 *                             ref: a Zeffy contact id, or g:<a payment of theirs> for a donor Zeffy has no contact for
 *                             (never an email in a link); kit: { state } | { none: true } | { error } | null (no email)
 * GET ?org=<p:slug|o:id>    → { success, donor, gifts, names, people, needs, onSite, level, keepAnonymous, … }
 * GET ?giving=<p:slug>      → { success, gifts, total, cents12, latest, suggest }   a partner's giving, for its card
 * GET ?needs=1              → { success, items }             what needs a person
 * GET ?thanks=1             → { success, items, staff }      every gift waiting for a thank-you (./_donor-thanks.js)
 * GET ?orgs=1               → { success, orgs }              every organization, to link a name to
 * POST { find: <text> }     → { success, names }             Zeffy names to link to an organization (posted: it can be an email)
 * POST { findPeople, except } → { success, people }          people to join with a person ("Same person as…")
 * GET ?gift=<payment id>    → { success, ref } | { success, org }   which donor a gift is (the MAJOR GIFT Slack link)
 * GET ?counts=1             → { success, checksWaiting, thanks, thanksMark }   the Checks tab's count, on whichever tab
 *                             is open, how many gifts wait for a thank-you (the sidebar's badge on Donors & Partners),
 *                             and a mark that changes whenever To thank or an answer does (open tabs read again)
 * POST { act, … }           → { success, … }                 a change (./_donor-crm.js act): links, Keep anonymous, the
 *                             same person, owner, notes (note-add, note-edit, note-delete), thank-yous (thanks, with
 *                             `was`: the state the person saw). `asked`: an answer to a Needs you question, refused (409)
 *                             if someone answered it since
 * A donor's page (?donor, ?org) also carries { owner, notes, history, staff }, and each gift its thank-you
 * GET ?timeline=<ref>       → { success, subject, items, kit, sources, more, me }   everything else that happened with
 *                             them: the team's email and meetings (Google), calls and texts (Quo), newsletters (Kit),
 *                             what the website emailed them, the team's changes, a partner's page (./_donor-timeline.js)
 * GET ?timeline=<ref>&local=1              → the same, from what the site holds only (after a change on the page)
 * GET ?timeline=<ref>&older=1&mail=&quo=   → { success, items, more }   older email and calls
 * GET ?timeline=<ref>&mailbox=&thread=     → { success, mailbox, thread, messages, hidden }   a conversation they're on (logged)
 * GET ?timeline=<ref>&call=<id>            → { success, status, dialogue }   a call's words (Quo; logged)
 * GET ?timeline=<ref>&sent=<id>            → { success, subject, at, html } | { success, gone, why }   a website email
 * GET ?signals=<ref>        → { success, state, signals?, note? }   what Kit Signals knows about a person (./_donor-signals.js)
 */
import { listView, needsView, thanksView, personView, orgView, orgSummary, orgsList, findNames, findPeople, giftOwner, act, movedTo, followMerges, noteWhere } from './_donor-crm.js';
import { kitFindSubscribers, kitConfigured } from './_kit.js';
import { checksFacts } from './_check-gifts.js';
import { thanksCount, thanksMark } from './_donor-thanks.js';
import { timelineView, olderView, mailThread, callTranscript, sentEmail } from './_donor-timeline.js';
import { signalsFor } from './_donor-signals.js';

const ok = (body = {}) => Response.json({ success: true, ...body });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });

export async function onRequestGet({ env, request, data }) {
  if (!env.DB) return fail('D1 binding missing', 503);
  const q = new URL(request.url).searchParams;
  try {
    if (q.get('counts')) {
      // Each on its own: one that can't be read never takes the other's count with it
      const [checks, thanks, thanksMarkNow] = await Promise.all([checksFacts(env.DB).catch(() => null), thanksCount(env.DB).catch(() => null), thanksMark(env.DB).catch(() => null)]);
      return ok({ checksWaiting: checks?.waiting || 0, thanks, thanksMark: thanksMarkNow });
    }
    if (q.get('needs')) return ok(await needsView(env));
    if (q.get('thanks')) return ok(await thanksView(env));
    if (q.get('giving')) return ok(await orgSummary(env, q.get('giving')));
    if (q.get('orgs')) return ok(await orgsList(env));
    // A change to a note: made or not (a page that never heard its answer asks)
    if (q.get('edit')) {
      const row = await env.DB.prepare('SELECT 1 AS y FROM donor_note_edits WHERE edit_id = ?').bind(String(q.get('edit'))).first().catch(() => null);
      return ok({ applied: !!row });
    }
    // Where a note is now (a change being made to it, its note gone from the page): its page, or 404 when deleted
    if (q.get('note')) {
      const w = await noteWhere(env, q.get('note'));
      return w ? ok(w) : fail('That note was deleted.', 404);
    }
    if (q.get('gift')) {
      const o = await giftOwner(env, q.get('gift'));
      return o ? ok(o) : fail('That gift isn’t in the donor list yet. It comes in within 15 minutes of reaching Zeffy.', 404);
    }
    if (q.get('org')) {
      const v = await orgView(env, q.get('org'));
      if (v?.moved) return ok({ org: v.moved });
      // Taken out (by a teammate, or in another tab): said so, and where what was said about it went
      if (v?.takenOut) return Response.json({ success: false, error: `${v.name || 'This organization'} was taken out: its gifts count for the people who gave them again.`, ...(v.back ? { back: v.back, backRef: v.backRef } : {}) }, { status: 404 });
      return v ? ok(v) : fail('No organization by that link. It may have been taken out, or merged into another partner.', 404);
    }
    // Kit Signals on a person's page (./_donor-signals.js)
    if (q.get('signals')) {
      try { return ok(await signalsFor(env, q.get('signals'))); } catch (e) { if (e.status && e.status !== 500) return fail(e.message, e.status); throw e; }
    }
    // A donor's timeline (./_donor-timeline.js): ref is a page's address (a contact id, g:<payment>, p:/o: an organization)
    if (q.get('timeline')) {
      const ref = q.get('timeline');
      const me = String(data?.userEmail || '').toLowerCase() || null;
      try {
        if (q.get('thread')) return ok(await mailThread(env, ref, { mailbox: q.get('mailbox'), thread: q.get('thread'), me }));
        if (q.get('call')) return ok(await callTranscript(env, ref, { call: q.get('call'), me }));
        if (q.get('sent')) return ok(await sentEmail(env, ref, { id: q.get('sent') }));
        const v = q.get('older') ? await olderView(env, ref, { mail: q.get('mail'), quo: q.get('quo') }) : await timelineView(env, ref, { local: !!q.get('local') });
        return v ? ok({ ...v, me }) : fail('No donor by that link. Their gifts may have moved to another donor in Zeffy.', 404);
      } catch (e) {
        // A refusal said in words (not their conversation, Quo not connected): said as it is
        if (e.status && e.status !== 500) return fail(e.message, e.status);
        throw e;
      }
    }
    if (q.get('donor')) {
      const v = await personView(env, q.get('donor'));
      // A Zeffy record whose gifts all moved to one other (Zeffy merged them): its address opens that one
      // (what was said about it follows it there now, not at the next 15-minute read: the page opens with its notes)
      if (!v) { const to = await movedTo(env, q.get('donor')); if (to) await followMerges(env.DB).catch((e) => console.error('[donors-admin] follow', e.message)); return to ? ok({ moved: to }) : fail('No donor by that link. Their gifts may have moved to another donor in Zeffy.', 404); }
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
    // (`went`: put on the website as another partner card meanwhile, so the page names the card that isn't needed)
    if (e.status && e.status < 500) return Response.json({ success: false, error: e.message, ...(e.went ? { went: e.went } : {}), ...(e.rev ? { rev: e.rev } : {}) }, { status: e.status });
    console.error('[donors-admin] post', e.message);
    return fail(typeof body?.find === 'string' || typeof body?.findPeople === 'string' ? 'The site didn’t answer.' : 'The site didn’t save that. Try again in a minute.', 500);
  }
}
