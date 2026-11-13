/**
 * What the SOARD connection offers besides tools: prompts (the starting points under Claude's + menu, "Write the
 * gala's recap") and resources (things to attach: how SOARD writes, how its emails are built, SOARD's facts, a
 * kid's or an event's page). Each prompt only says what to do with the tools; the facts always come from them.
 */

import { orgFacts } from '../_org-facts.js';
import { BLOCK_TYPES, DEFAULT_SIGNOFF } from '../_custom-email.js';
import { loadEvents } from '../_newsletter-drafts.js';
import { monthlyKey, monthBefore } from '../_newsletter-drafts.js';
import { dayIn } from '../../../public/admin/events-shared.js';
import { kidName, tidy, stripHtml, roomNames } from '../_reveal-invite-email.js';
import { PREVIEW_URI, APP_MIME, PREVIEW_CSP, previewHtml } from './preview.js';
import { PHOTO_URI, PHOTO_CSP, photoBoxHtml, SCHEDULE_URI, SCHEDULE_CSP, scheduleHtml } from './field.js';
import { SITE_URL, SLUG } from './core.js';

export const VOICE = [
  '# How SOARD writes',
  '',
  'Sunshine on a Ranney Day (SOARD) is an Atlanta nonprofit that builds dream bedrooms and accessible bathrooms for kids with special needs.',
  '',
  '- Warm, plain and specific: the kid’s name, what they love, what changed for them. Short sentences.',
  '- Say “kids” and “families”. A kid is never their diagnosis: “Rowan, who has cerebral palsy”, not “a CP patient”.',
  '- No em dashes, ever. Use a period, a comma or a colon.',
  '- Nothing that reads like AI: no “we’re thrilled to announce”, no “in today’s world”, no lists of three adjectives.',
  '- Peter Ranney is always Peter, never Pete. The Advisory Board is the Advisory Board, never “advisors”.',
  '- Never invent a fact, a number, a date or a quote. If the tools don’t say it, ask or leave it out.',
  '- A family’s private details (diagnosis beyond what their page says, address, contact, application) never go in anything public.',
  '- Donors who asked to give anonymously are thanked but never named anywhere public.',
].join('\n');

export const EMAIL_GUIDE = [
  '# How SOARD’s emails are built',
  '',
  'Every email goes out in SOARD’s own layout: the site wraps what you write in SOARD’s header, the team’s sign-off over the plushie picture, and the footer. You write the middle as blocks:',
  '',
  ...BLOCK_TYPES.map((t) => `- **${t}**`),
  '',
  '- cover: the big top (kicker, headline, a photo {id, alt}, a button). A *word* in stars in a headline is set in the accent.',
  '- text: paragraphs; a blank line starts a new one; **bold**, *accent*, [words](https://a-link).',
  '- photo: one picture, by its id from get_kid or get_event; wide: true for a designed graphic edge to edge. photos: two side by side.',
  '- video: a YouTube or Cloudflare Stream link (its still shows, with a play button). button: words and a link. give: the give band.',
  `- The closing line over the team picture defaults to “${DEFAULT_SIGNOFF}”`,
  '',
  'Then: show_email to see it, send_me_a_test for an inbox copy (only to you), draft_in_kit to put it in Kit. A person always sends it from Kit. Nothing here sends to a list.',
  '',
  'The site’s own emails (reveal invites, Project Kickoff, Project Reveal, Event Recap, Monthly Impact) aren’t written from blocks: get_email_words shows their parts, and set_email_words changes the words of any part.',
].join('\n');

const text = (t) => ({ type: 'text', text: t });
const ask = (t) => ({ messages: [{ role: 'user', content: text(t) }] });

// ── Prompts ───────────────────────────────────────────────────────────────

export const PROMPTS = Object.freeze([
  { name: 'event_recap', title: 'An event’s recap email', description: 'Write the recap email for an event, in its own colors, from its photos and numbers.',
    arguments: [{ name: 'event', description: 'The event (part of its name or its page name)', required: true }],
    get: ({ event }) => ask(`Write the recap email for the SOARD event “${event}”. Find it with find_events and read it with get_event. Then read its recap email with get_email_words (its key is in get_event), and suggest words for each part in SOARD’s voice (see the How SOARD writes guide): warm thanks, what the night did for kids, the real numbers only. Show me the words and the email with show_email. Change nothing until I say so; then save them with set_email_words, send me a test with send_me_a_test, and when I’m happy put it in Kit with draft_in_kit.`) },
  { name: 'monthly_impact', title: 'This month’s Monthly Impact', description: 'The Monthly Impact email for the month just ended.',
    arguments: [{ name: 'month', description: 'YYYY-MM (leave out for the month just ended)', required: false }],
    get: ({ month }) => {
      const key = monthlyKey(month && /^\d{4}-\d{2}$/.test(month) ? month : monthBefore(dayIn()));
      return ask(`Work on the Monthly Impact email ${key}. Read it with get_email_words and show it with show_email. Tell me what it says and suggest better words where it would help, in SOARD’s voice, using only what the tools say happened (soard_numbers, upcoming_reveals and find_kids help). Change nothing until I say so; then set_email_words, send_me_a_test, and draft_in_kit when I’m happy.`);
    } },
  { name: 'new_email', title: 'Write a new email', description: 'A new email in SOARD’s layout about anything: a kid, an event, a thank-you, news.',
    arguments: [{ name: 'about', description: 'What it’s about', required: true }],
    get: ({ about }) => ask(`Write a new SOARD email about: ${about}. Look up the facts first (find_kids, get_kid, find_events, get_event, soard_numbers) and use their photos by id. Follow How SOARD’s emails are built and How SOARD writes. Save it with save_written_email, show it with show_email, and ask me before sending a test or putting it in Kit.`) },
  { name: 'reveal_prep', title: 'Get ready for a reveal', description: 'Everything still to do before a kid’s reveal: their room’s things, shipments, invites.',
    arguments: [{ name: 'kid', description: 'The kid (part of their name)', required: true }],
    get: ({ kid }) => ask(`Help me get ready for ${kid}’s reveal. Use upcoming_reveals for the day, get_kid for their page and their emails (invites, Kickoff, Reveal), kid_room for what their room is still waiting on, and shipments for what’s on its way. Give me one short list of what’s left, soonest problem first, and say where each is done in the admin. Don’t change anything.`) },
  { name: 'thank_donors', title: 'Thank recent donors', description: 'Recent gifts from Zeffy, and a short personal thank-you for each.',
    arguments: [{ name: 'days', description: 'How many days back (default 7)', required: false }],
    get: ({ days }) => ask(`List the gifts from the last ${Number(days) > 0 ? Number(days) : 7} days with recent_gifts, biggest first, and write a short, warm, personal thank-you for each giver in SOARD’s voice (mention the campaign; for a monthly gift, thank them for giving every month). Anyone who asked to give anonymously is thanked but never named anywhere public. Don’t send anything: these are for a person to send.`) },
  { name: 'this_week', title: 'This week at SOARD', description: 'A short briefing: reveals ahead, gifts, checks and families waiting, papers expiring, what isn’t published.',
    arguments: [],
    get: () => ask('Give me a short briefing on this week at SOARD: upcoming_reveals (the next two weeks), recent_gifts (last 7 days, the total and the biggest), checks_waiting, find_families (anyone who replied and is waiting on us), vendor_papers (missing or expiring), changes_not_live, automations (anything that needs a look), and recent_changes (the last 2 days). Headlines first, one line each, then anything that needs someone today. Don’t change anything.') },
  { name: 'update_page', title: 'Update a page’s words', description: 'Change the words on a kid’s page, an event, an article or a partner.',
    arguments: [{ name: 'page', description: 'Which page (part of its name)', required: true }, { name: 'change', description: 'What to change', required: false }],
    get: ({ page, change }) => ask(`Find the page “${page}” with find_pages and read it with get_page.${change ? ` I want to: ${change}.` : ''} Suggest the new words in SOARD’s voice and show me exactly what changes, field by field. Save with edit_page only after I say so, and remind me it goes live when someone presses Publish in the admin.`) },
]);

// ── Resources ─────────────────────────────────────────────────────────────

export const RESOURCES = Object.freeze([
  { uri: 'soard://guide/voice', name: 'voice', title: 'How SOARD writes', description: 'SOARD’s voice and the rules every word follows', mimeType: 'text/markdown', read: async () => VOICE },
  { uri: 'soard://guide/emails', name: 'emails', title: 'How SOARD’s emails are built', description: 'The blocks of a written email and how an email gets to Kit', mimeType: 'text/markdown', read: async () => EMAIL_GUIDE },
  { uri: 'soard://facts', name: 'facts', title: 'SOARD’s facts', description: 'Name, EIN, address, mission, values and the boilerplate, as the board page keeps them', mimeType: 'text/markdown', read: factsText },
]);

export const TEMPLATES = Object.freeze([
  { uriTemplate: 'soard://kids/{slug}', name: 'kid', title: 'A kid’s page', description: 'One kid’s makeover page: their story, rooms and year', mimeType: 'text/markdown' },
  { uriTemplate: 'soard://events/{slug}', name: 'event', title: 'An event', description: 'One event: its day, place, theme and numbers', mimeType: 'text/markdown' },
]);


async function factsText(env) {
  const f = await orgFacts(env);
  const line = (label, v) => (v ? `- **${label}:** ${v}` : null);
  const where = (a) => (a ? `${a.street}, ${a.city}, ${a.state} ${a.zip}` : null);
  return [
    `# ${f.name || 'Sunshine on a Ranney Day'}`, '',
    line('Short name', f.shortName), line('Legal name', f.legalName), line('EIN', f.ein), line('Address', where(f.address)), line('Mailing address', where(f.mailing)),
    line('Phone', f.phone), line('Email', f.email), line('Website', f.website), line('Founded', f.founded), line('Founders', f.founders), line('Tagline', f.tagline),
    f.irs ? line('IRS', `${f.irs.exempt ? 'tax-exempt' : 'not listed as exempt'}${f.irs.since ? ` since ${f.irs.since}` : ''}${f.irs.publicCharity ? `, ${f.irs.publicCharity}` : ''}`) : null,
    '', f.mission ? `## Mission\n\n${f.mission}` : null, f.vision ? `\n## Vision\n\n${f.vision}` : null,
    f.values?.length ? `\n## Values\n\n${f.values.map((v) => `- **${v.name}:** ${v.text}`).join('\n')}` : null,
    f.bio ? `\n## About SOARD (the boilerplate)\n\n${f.bio}` : null,
  ].filter((x) => x !== null).join('\n');
}

async function kidText(env, slug) {
  const row = await env.DB.prepare('SELECT slug, data FROM kids WHERE slug = ?').bind(slug).first();
  if (!row) return null;
  const k = JSON.parse(row.data);
  if (k.publishStatus && k.publishStatus !== 'published') return `# ${kidName(k, slug)}\n\nThis page isn’t on the site yet. Use get_kid for what the admin holds.`;
  return [`# ${kidName(k, slug)}`, '', `- **Year:** ${k.year || '?'}`, `- **Rooms:** ${roomNames(k).join(', ') || '?'}`, `- **Page:** ${SITE_URL}/kids/${slug}/`, '',
    k.heroSummary ? tidy(k.heroSummary) : '', '', tidy(stripHtml(k.bio || '')).slice(0, 6000)].join('\n');
}

async function eventText(env, slug) {
  const ev = (await loadEvents(env.DB)).find((e) => e.slug === slug);
  if (!ev) return null;
  return [`# ${tidy(ev.title || slug)}`, '', `- **Day:** ${ev.date || '?'}`, ev.location ? `- **Where:** ${tidy(ev.location)}` : null, ev.theme ? `- **Theme:** ${tidy(ev.theme)}` : null,
    ...(ev.highlights || []).filter((h) => h?.value).map((h) => `- ${tidy(h.value)} ${tidy(h.label || '')}`), '', tidy(stripHtml(ev.description || ev.body || '')).slice(0, 6000)]
    .filter((x) => x !== null).join('\n');
}

/** resources/read → { contents } or null (not one of ours) */
export async function readResource(env, uri) {
  if (uri === PREVIEW_URI) return [{ uri, mimeType: APP_MIME, text: previewHtml(), _meta: { ui: { csp: PREVIEW_CSP, prefersBorder: false } } }];
  if (uri === PHOTO_URI) return [{ uri, mimeType: APP_MIME, text: photoBoxHtml(), _meta: { ui: { csp: PHOTO_CSP, prefersBorder: true } } }];
  if (uri === SCHEDULE_URI) return [{ uri, mimeType: APP_MIME, text: scheduleHtml(), _meta: { ui: { csp: SCHEDULE_CSP, prefersBorder: true } } }];
  const fixed = RESOURCES.find((r) => r.uri === uri);
  if (fixed) return [{ uri, mimeType: fixed.mimeType, text: await fixed.read(env) }];
  const m = /^soard:\/\/(kids|events)\/([a-z0-9][a-z0-9-]{0,120})$/.exec(uri);
  if (!m || !SLUG.test(m[2])) return null;
  const t = m[1] === 'kids' ? await kidText(env, m[2]) : await eventText(env, m[2]);
  return t === null ? null : [{ uri, mimeType: 'text/markdown', text: t }];
}

/** completion/complete: page names for a prompt's kid or event, and the resource templates' slug */
export async function complete(env, { ref, argument }) {
  const value = String(argument?.value || '').toLowerCase();
  const which = ref?.type === 'ref/resource' ? (String(ref.uri || '').startsWith('soard://events/') ? 'event' : 'kid')
    : argument?.name === 'event' ? 'event' : argument?.name === 'kid' || argument?.name === 'page' ? 'kid' : null;
  if (argument?.name === 'month') {
    const now = dayIn();
    const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(`${now.slice(0, 7)}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1 - i); return d.toISOString().slice(0, 7); });
    return months.filter((m) => m.startsWith(value));
  }
  if (!which) return [];
  if (which === 'event') return (await loadEvents(env.DB)).map((e) => e.slug).filter((s) => s.includes(value)).slice(0, 100);
  const { results = [] } = await env.DB.prepare('SELECT slug FROM kids ORDER BY year DESC, slug').all();
  return results.map((r) => r.slug).filter((s) => s.includes(value)).slice(0, 100);
}
