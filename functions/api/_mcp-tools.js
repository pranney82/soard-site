/**
 * The SOARD connection for Claude: its tools (served at /mcp, ../mcp.js).
 *
 * Staff connect their own Claude to the site (Peter's plan for Linzi, step 3:
 * "a SOARD connection for her Claude, drafts only"). Through it Claude can look
 * up SOARD's kids and events, write an email in SOARD's own layout (Write an
 * email), change the words of the emails the site drafts by itself (Edit
 * words), send the person a test copy, and put a draft in Kit. Nothing more:
 * it never sends to a list, schedules, deletes, or changes who an email goes to,
 * and every change is logged in History under the person, "via Claude".
 *
 * Every tool reuses what the admin itself does (Write an email, Edit words,
 * Draft in Kit), so Claude and the admin can never disagree.
 */

import { SITE_URL, kidName, stripHtml, tidy, roomNames, shortStory } from './_reveal-invite-email.js';
import { BLOCK_TYPES, imageId, emailProblems } from './_custom-email.js';
import { listCustomEmails, readCustomEmail, saveCustomEmail, customEmailStatus, draftCustomEmail, sendCustomPreview, isEmailId } from './_custom-emails.js';
import { EMAIL_WORDS, parseWordsKey } from './_email-words.js';
import { emailWordsView, saveEmailWords, sendEmailWordsTest } from './_email-words-draft.js';
import { kidEmailsStatus, draftKidEmail } from './kid-kit-emails.js';
import { revealsAdminView } from './reveals-admin.js';
import { loadEvents, loadDocs, docFor, newsletterStatus, draftNewsletterNow, recapKey, monthlyKey, monthBefore } from './_newsletter-drafts.js';
import { recapParts, recapUrl, eventTitle } from './_newsletter-email.js';
import { seriesOf, isOver, dayIn, eventPath } from '../../public/admin/events-shared.js';
import { logAudit } from './_audit.js';

const VIA = ' (via Claude)';
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;
const kitUrl = (id) => `https://app.kit.com/campaigns/${encodeURIComponent(id)}`;
const adminUrl = (hash) => `${SITE_URL}/admin/${hash}`;
const isoDay = (iso) => (iso ? String(iso).slice(0, 10) : null);

/** A tool's answer: the facts as JSON for Claude, the same as structured content */
const done = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });
/** A tool that couldn't do it says why, in words a person can act on */
const refuse = (why) => ({ content: [{ type: 'text', text: why }], isError: true });

const parseKid = (row) => {
  try { return row ? { ...JSON.parse(row.data), slug: row.slug } : null; } catch { return null; }
};
const photosOf = (list, max) => (list || []).filter((p) => p && (p.url || p.id)).slice(0, max)
  .map((p) => ({ id: imageId(p.url || p.id), alt: tidy(p.alt || '') })).filter((p) => p.id);

/** Where an email stands in Kit, in a few plain words */
const standing = (x) => {
  if (!x) return 'not drafted';
  if (x.state === 'draft') return x.edited ? 'a draft in Kit that someone has changed there' : 'a draft in Kit, waiting for someone to send it';
  return { none: 'not drafted', nojob: 'no JobTread job, so no reveal to invite to', waiting: 'not drafted yet', skipped: 'won’t draft itself', drafting: 'being drafted right now', scheduled: 'scheduled in Kit', sent: 'sent from Kit', deleted: 'deleted in Kit', check: 'in Kit, but who it goes to needs checking' }[x.state] || x.state;
};
const emailRow = (key, x) => ({
  key, what: EMAIL_WORDS[parseWordsKey(key)?.kind]?.what || key, stands: standing(x),
  ...(x?.url ? { kit: x.url } : {}), ...(x?.block ? { waitingFor: x.block } : {}), ...(x?.error ? { problem: x.error } : {}),
});

// ── Kids ──────────────────────────────────────────────────────────────────

async function findKids(env, { query = '', year, status } = {}) {
  const { results = [] } = await env.DB.prepare('SELECT slug, data FROM kids').all();
  const q = String(query || '').trim().toLowerCase();
  const kids = results.map(parseKid).filter(Boolean)
    .filter((k) => !q || `${k.name} ${k.slug}`.toLowerCase().includes(q))
    .filter((k) => !year || Number(k.year) === Number(year))
    .filter((k) => !status || (k.status || 'in-progress') === status)
    .sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || String(a.name).localeCompare(String(b.name)))
    .slice(0, 60);
  return done({
    kids: kids.map((k) => ({
      slug: k.slug, name: kidName(k, k.slug), year: k.year || null, status: k.status || 'in-progress',
      onTheSite: !k.publishStatus || k.publishStatus === 'published', rooms: roomNames(k), photos: (k.photos || []).length,
      story: shortStory(k, 160), page: `${SITE_URL}/kids/${k.slug}/`,
    })),
  });
}

async function getKid(env, { slug }) {
  if (!SLUG.test(String(slug || ''))) return refuse('That isn’t a kid’s page name. Use find_kids to get it.');
  const kid = parseKid(await env.DB.prepare('SELECT slug, data FROM kids WHERE slug = ?').bind(slug).first());
  if (!kid) return refuse('There’s no kid page by that name. Use find_kids to look it up.');
  // Their JobTread job, for the reveal invites; JobTread not answering leaves those out, never the rest
  let jobId = '';
  let jobNote = null;
  try { jobId = env.JOBTREAD_GRANT_KEY ? (await revealsAdminView(env)).jobs?.[slug] || '' : ''; } catch { jobNote = 'JobTread didn’t answer, so the reveal invites aren’t listed. Ask again in a minute.'; }
  const st = await kidEmailsStatus(env, slug, jobId);
  const emails = [
    ...(jobId ? [emailRow(`invite:${jobId}`, st.invite), emailRow(`watch:${jobId}`, st.watch)] : []),
    emailRow(`kickoff:${slug}`, st.kickoff), emailRow(`reveal:${slug}`, st.reveal),
  ];
  return done({
    slug, name: kidName(kid, slug), year: kid.year || null, status: kid.status || 'in-progress',
    onTheSite: !kid.publishStatus || kid.publishStatus === 'published',
    rooms: roomNames(kid), age: kid.age || null, diagnosis: kid.diagnosis ? tidy(kid.diagnosis) : null,
    summary: kid.heroSummary ? tidy(kid.heroSummary) : null, story: tidy(stripHtml(kid.bio)).slice(0, 4000),
    quote: kid.quote ? tidy(kid.quote) : null,
    partners: [...new Set((kid.partnerLogos || []).map((p) => tidy(p.name || '')).filter(Boolean))],
    video: kid.videoUrl || (kid.streamVideoId ? `https://customer-cuav5h47lgfe96ql.cloudflarestream.com/${kid.streamVideoId}/watch` : null),
    give: kid.fundraisingUrl || null,
    photos: photosOf([kid.heroImage && { url: kid.heroImage, alt: kid.heroImageAlt }, ...(kid.photos || [])].filter(Boolean), 60),
    page: `${SITE_URL}/kids/${slug}/`, admin: adminUrl(`#kids/${slug}`),
    emails, ...(st.off ? { kitPaused: st.off } : {}), ...(jobNote ? { note: jobNote } : {}),
  });
}

// ── Events ────────────────────────────────────────────────────────────────

async function findEvents(env, { query = '' } = {}) {
  const today = dayIn();
  const q = String(query || '').trim().toLowerCase();
  const [events, docs] = await Promise.all([loadEvents(env.DB), loadDocs(env.DB)]);
  const list = events.filter((ev) => !q || `${ev.title || ''} ${ev.slug}`.toLowerCase().includes(q))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 40);
  return done({
    events: list.map((ev) => ({
      slug: ev.slug, name: eventTitle(ev), date: ev.date || null, series: seriesOf(ev)?.key || null, over: isOver(ev, today),
      photos: recapParts(ev, events, docFor(ev, docs)).photos.length, page: `${SITE_URL}${eventPath(ev, events)}`,
    })),
  });
}

async function getEvent(env, { slug }) {
  if (!SLUG.test(String(slug || ''))) return refuse('That isn’t an event’s page name. Use find_events to get it.');
  const [events, docs] = await Promise.all([loadEvents(env.DB), loadDocs(env.DB)]);
  const ev = events.find((e) => e.slug === slug);
  if (!ev) return refuse('There’s no event by that name. Use find_events to look it up.');
  const pageDoc = docFor(ev, docs);
  const { photos, sponsors } = recapParts(ev, events, pageDoc);
  const key = recapKey(slug);
  const st = await newsletterStatus(env, key).catch(() => null);
  return done({
    slug, name: eventTitle(ev), date: ev.date || null, location: ev.location ? tidy(ev.location) : null, series: seriesOf(ev)?.key || null,
    theme: ev.theme ? tidy(ev.theme) : null, over: isOver(ev, dayIn()), photographer: ev.photographer ? tidy(ev.photographer) : null,
    highlights: (ev.highlights || []).filter((h) => h?.value).map((h) => `${tidy(h.value)} ${tidy(h.label || '')}`.trim()),
    sponsors: sponsors.map((t) => ({ level: tidy(t.tier || ''), names: t.names.map((n) => tidy(n.name || '')).filter(Boolean) })),
    photos: photosOf(photos, 100), page: recapUrl(ev, events), admin: adminUrl(`#events/${slug}`),
    recapEmail: emailRow(key, st ? { ...st, url: st.id ? kitUrl(st.id) : null } : null),
  });
}

// ── Written emails (Admin → Emails & invites → Write an email) ───────────

const writtenRow = (e) => ({ id: e.id, subject: e.subject || '(no subject yet)', inKit: e.broadcastId ? true : false, updated: isoDay(e.updatedAt), updatedBy: e.updatedBy || null, admin: adminUrl(`#messages/write/${e.id}`) });

async function listWritten(env) {
  return done({ emails: (await listCustomEmails(env.DB)).slice(0, 50).map(writtenRow) });
}

async function getWritten(env, { id }) {
  if (!isEmailId(id)) return refuse('That isn’t a written email’s id. Use list_written_emails to get it.');
  const e = await readCustomEmail(env.DB, id);
  if (!e) return refuse('That email isn’t here any more.');
  const st = await customEmailStatus(env, e);
  return done({
    ...writtenRow(e), preview: e.preview, signoff: e.signoff, blocks: e.blocks,
    stands: standing(st.state === 'writing' ? { state: 'none' } : { state: st.state === 'edited' ? 'draft' : st.state, edited: st.state === 'edited' }),
    ...(st.id ? { kit: kitUrl(st.id) } : {}), missing: emailProblems(e),
  });
}

async function saveWritten(env, args, me) {
  const id = args.id || null;
  if (id && !isEmailId(id)) return refuse('That isn’t a written email’s id. Leave it out to start a new email.');
  const blocks = Array.isArray(args.blocks) ? args.blocks : [];
  if (blocks.some((b) => !BLOCK_TYPES.includes(b?.type))) return refuse(`Every block needs a type, one of: ${BLOCK_TYPES.join(', ')}.`);
  if (id) {
    const had = await readCustomEmail(env.DB, id);
    if (!had) return refuse('That email isn’t here any more.');
    const st = await customEmailStatus(env, had);
    if (['edited', 'scheduled', 'sent'].includes(st.state)) return refuse(`This one is ${st.state === 'edited' ? 'a draft someone has changed in Kit' : `${st.state} in Kit`}, so it’s left as it is. Start a new email instead (leave out the id).`);
  }
  const e = await saveCustomEmail(env.DB, { id, email: { subject: args.subject, preview: args.preview, signoff: args.signoff, blocks }, by: me });
  await logAudit(env.DB, { userEmail: me, action: id ? 'updated' : 'created', entityType: 'newsletter', entitySlug: e.id, entityName: `Write an email: ${e.subject || 'untitled'}${VIA}`, gitStatus: 'ok' }).catch(() => {});
  const missing = emailProblems(e);
  return done({
    saved: true, ...writtenRow(e), missing,
    next: missing.length ? `Before it can go to Kit, add ${missing.join(', and ')}.` : e.broadcastId ? 'Saved here. Use draft_in_kit to bring the draft in Kit up to date.' : 'Saved here. Use send_me_a_test to see it in an inbox, or draft_in_kit to put it in Kit as a draft.',
  });
}

// ── The site's own emails (Edit words) ────────────────────────────────────

async function getWords(env, { key }) {
  if (!parseWordsKey(key)) return refuse('That isn’t one of the emails. Get its key from get_kid, get_event, or monthly:YYYY-MM for a Monthly Impact.');
  const v = await emailWordsView(env, key);
  return done({
    key, what: v.what, parts: v.parts.map((p) => ({ part: p.key, name: p.label, max: p.max })),
    theirWords: v.words, sitesWords: v.siteWords,
    asItWouldGo: v.email ? { subject: v.email.subject, preview: v.email.preview } : null,
    ...(v.block ? { cantShow: v.block } : {}), ...(v.note ? { waitingFor: v.note } : {}),
    howToWrite: 'Leave a part out (or empty) to keep the site’s words. In the opening and the give band’s words, **two stars** make words bold, *one star* sets a word in italics, and [words](https://a-link) makes a link; a blank line in the opening starts a new paragraph.',
  });
}

async function setWords(env, { key, words }, me) {
  if (!parseWordsKey(key)) return refuse('That isn’t one of the emails. Get its key from get_kid, get_event, or monthly:YYYY-MM for a Monthly Impact.');
  const r = await saveEmailWords(env, key, words && typeof words === 'object' ? words : {}, { by: me, via: VIA });
  return done({ key, result: r.result, said: r.message, words: r.words, asItWillGo: r.email ? { subject: r.email.subject, preview: r.email.preview } : null });
}

// ── A test copy, and a draft in Kit ───────────────────────────────────────

async function sendTest(env, { key, id }, me) {
  if (id) {
    if (!isEmailId(id)) return refuse('That isn’t a written email’s id.');
    const r = await sendCustomPreview(env, { id, to: me });
    if (!r.ok) return refuse(r.error);
  } else if (key) {
    if (!parseWordsKey(key)) return refuse('That isn’t one of the emails.');
    const r = await sendEmailWordsTest(env, key, me);
    if (!r.ok) return refuse(r.error);
  } else return refuse('Say which email: a written email’s id, or one of the site’s emails by its key.');
  await logAudit(env.DB, { userEmail: me, action: 'sent', entityType: 'newsletter', entitySlug: id || key, entityName: `[Preview] to ${me}${VIA}`, gitStatus: 'ok' }).catch(() => {});
  return done({ sent: true, to: me, said: `A test copy marked [Preview] is on its way to ${me}. Nobody else gets it.` });
}

async function draftInKit(env, { key, id }, me) {
  if (id) {
    if (!isEmailId(id)) return refuse('That isn’t a written email’s id.');
    const r = await draftCustomEmail(env, { id, by: me });
    if (r.result === 'drafted') {
      const e = await readCustomEmail(env.DB, id);
      await logAudit(env.DB, { userEmail: me, action: 'created', entityType: 'newsletter', entitySlug: String(r.id), entityName: `Kit draft: ${e?.subject || id}${VIA}`, gitStatus: 'ok' }).catch(() => {});
    }
    const said = {
      drafted: 'It’s a draft in Kit now, for the newsletter list. Nothing goes out until someone sends it from Kit.',
      updated: 'The draft in Kit has the latest words now. Nothing goes out until someone sends it from Kit.',
      unchanged: 'The draft in Kit already says this.',
      edited: 'Someone changed the draft in Kit, so it’s left as they made it. Make changes there, or delete it in Kit and draft it again.',
      sent: 'This one was sent from Kit already.', scheduled: 'This one is scheduled in Kit, so it’s left as it is.',
      off: 'Kit drafts are paused (Reveals → Invites in the admin).', missing: `Before it can go to Kit, add ${(r.missing || []).join(', and ')}.`,
    }[r.result] || r.error || 'Kit didn’t take it. Try again in a minute.';
    return ['drafted', 'updated', 'unchanged'].includes(r.result) ? done({ result: r.result, said, ...(r.id ? { kit: kitUrl(r.id) } : {}) }) : refuse(said);
  }
  const parsed = parseWordsKey(key);
  if (!parsed) return refuse('Say which email: a written email’s id, or one of the site’s emails by its key.');
  let r;
  if (parsed.kind === 'recap' || parsed.kind === 'monthly') {
    r = await draftNewsletterNow(env, { key, by: me });
    if (r.newsletter === 'drafted' && r.id) await logAudit(env.DB, { userEmail: me, action: 'created', entityType: 'newsletter', entitySlug: String(r.id), entityName: `Kit ${EMAIL_WORDS[parsed.kind].what} draft: ${parsed.id}${VIA}`, gitStatus: 'ok' }).catch(() => {});
    if (r.newsletter === 'drafted') return done({ result: 'drafted', said: 'It’s a draft in Kit now. Nothing goes out until someone sends it from Kit.', kit: kitUrl(r.id) });
    if (r.newsletter === 'unchanged') return done({ result: 'already', said: 'It’s already in Kit.', kit: kitUrl(r.id) });
    return refuse(r.reason || r.error || 'Kit didn’t take it. Try again in a minute.');
  }
  // A kid's: the invites go by the JobTread job, Kickoff and Project Reveal by the kid
  let slug = parsed.id;
  let jobId = '';
  if (parsed.kind === 'invite' || parsed.kind === 'watch') {
    jobId = parsed.id;
    const jobs = (await revealsAdminView(env).catch(() => ({ jobs: {} }))).jobs || {};
    slug = Object.keys(jobs).find((s) => jobs[s] === jobId) || '';
    if (!slug) return refuse('No kid page matches that JobTread job.');
  }
  r = await draftKidEmail(env, { slug, kind: parsed.kind, jobId, by: me, via: VIA });
  if (r.ok && r.made) return done({ result: 'drafted', said: 'It’s a draft in Kit now. Nothing goes out until someone sends it from Kit.', ...(r.url ? { kit: r.url } : {}) });
  if (r.ok) return done({ result: 'already', said: 'It’s already in Kit.', ...(r.url ? { kit: r.url } : {}) });
  return refuse(r.reason || r.error || 'Kit didn’t take it. Try again in a minute.');
}

// ── The tools, as Claude sees them ────────────────────────────────────────

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const picture = { type: 'object', properties: { id: { type: 'string', description: 'A photo id from get_kid or get_event' }, alt: { type: 'string', description: 'What’s in it, for people who can’t see it' } }, additionalProperties: false };
const KEY = { type: 'string', description: 'The email’s key: from get_kid (invite:, watch:, kickoff:, reveal:), get_event (recap:), or monthly:YYYY-MM for the Monthly Impact of a month' };

/** In a fixed order, so Claude's view of them never shifts */
export const TOOLS = Object.freeze([
  { name: 'find_kids', title: 'Find kids', annotations: { title: 'Find kids', ...READ },
    description: 'SOARD’s kids (each makeover’s page): name, year, status (in-progress or completed), rooms, a short story, how many photos, and their page. Filter by part of a name, a year or a status.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Part of a name' }, year: { type: 'integer' }, status: { type: 'string', enum: ['in-progress', 'completed'] } }, additionalProperties: false } },
  { name: 'get_kid', title: 'A kid’s page', annotations: { title: 'A kid’s page', ...READ },
    description: 'One kid in full: the story, rooms, partners, video, their photos (ids to use as pictures in a written email), and their four emails the site drafts in Kit (reveal invite, whole-list invite, Project Kickoff, Project Reveal) with where each stands and its key.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string', description: 'The kid’s page name, from find_kids' } }, required: ['slug'], additionalProperties: false } },
  { name: 'find_events', title: 'Find events', annotations: { title: 'Find events', ...READ },
    description: 'SOARD’s events (the gala, the golf tournament and others), newest first: date, whether it’s over, how many photos, and its page.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Part of a name' } }, additionalProperties: false } },
  { name: 'get_event', title: 'An event', annotations: { title: 'An event', ...READ },
    description: 'One event in full: date, place, theme, numbers, sponsors by level, the photographer’s photos (ids to use as pictures in a written email), and its recap email with where it stands and its key.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string', description: 'The event’s page name, from find_events' } }, required: ['slug'], additionalProperties: false } },
  { name: 'list_written_emails', title: 'Written emails', annotations: { title: 'Written emails', ...READ },
    description: 'The emails staff have written in Admin → Emails & invites → Write an email, newest first, with their ids.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_written_email', title: 'A written email', annotations: { title: 'A written email', ...READ },
    description: 'One written email in full (subject, preview line, closing line, and its blocks), where it stands in Kit, and what it still needs before it can go to Kit.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'From list_written_emails' } }, required: ['id'], additionalProperties: false } },
  { name: 'save_written_email', title: 'Write an email', annotations: { title: 'Write an email', ...WRITE, idempotentHint: false },
    description: [
      'Write an email in SOARD’s own layout, or rewrite one: the site wraps the blocks in its header, the team’s sign-off and its footer, exactly as Write an email in the admin does. With an id, the whole email is replaced by what you send, so read it first with get_written_email. Saving never sends anything.',
      'Blocks, in order: cover (the big top: kicker, headline, photo {id, alt}, buttonText, url), heading (text), text (text; a blank line starts a paragraph, **bold**, *accent*, [words](https://link)), photo (id, alt, wide: true for a designed graphic edge to edge, url), photos (two side by side: a {id, alt}, b {id, alt}), video (url: YouTube or Cloudflare Stream, caption), button (text, url), give (the give band: kicker, headline, words, buttonText, url; any left out keep SOARD’s usual words and the donate page).',
      'Use photo ids from get_kid or get_event. In a headline, *stars* around a word set it in the accent.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Leave out to start a new email' },
        subject: { type: 'string' }, preview: { type: 'string', description: 'The gray line after the subject in the inbox' },
        signoff: { type: 'string', description: 'The closing line over the team picture' },
        blocks: { type: 'array', items: { type: 'object', properties: {
          type: { type: 'string', enum: [...BLOCK_TYPES] }, kicker: { type: 'string' }, headline: { type: 'string' }, text: { type: 'string' }, words: { type: 'string' },
          photo: picture, a: picture, b: picture, id: { type: 'string' }, alt: { type: 'string' }, wide: { type: 'boolean' },
          url: { type: 'string' }, buttonText: { type: 'string' }, caption: { type: 'string' },
        }, required: ['type'] } },
      },
      required: ['subject', 'blocks'], additionalProperties: false,
    } },
  { name: 'get_email_words', title: 'An email’s words', annotations: { title: 'An email’s words', ...READ },
    description: 'One of the emails the site drafts by itself (reveal invites, Project Kickoff, Project Reveal, Event Recap, Monthly Impact): its parts, the site’s own words for each, any words staff have given it, and its subject and preview line as it would go now.',
    inputSchema: { type: 'object', properties: { key: KEY }, required: ['key'], additionalProperties: false } },
  { name: 'set_email_words', title: 'Change an email’s words', annotations: { title: 'Change an email’s words', ...WRITE },
    description: 'Put your own words in one of the emails the site drafts by itself, part by part: subject, preview, opening, askHeadline, askWords (the give band’s), closing; the invites have no give band. The facts (the day, the photos) still come from JobTread and the pages. Parts left out keep the site’s words, and sending no parts puts every part back to the site’s own. A draft already in Kit that nobody has changed there takes them straight away; one someone changed in Kit is left alone. Never sends anything.',
    inputSchema: { type: 'object', properties: { key: KEY, words: { type: 'object', properties: {
      subject: { type: 'string' }, preview: { type: 'string' }, opening: { type: 'string' }, askHeadline: { type: 'string' }, askWords: { type: 'string' }, closing: { type: 'string' },
    }, additionalProperties: false } }, required: ['key', 'words'], additionalProperties: false } },
  { name: 'send_me_a_test', title: 'Send me a test', annotations: { title: 'Send me a test', ...WRITE },
    description: 'Email a test copy, marked [Preview], to you (the person signed in) and nobody else: a written email by its id, or one of the site’s emails by its key, with its saved words.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'A written email’s id' }, key: KEY }, additionalProperties: false } },
  { name: 'draft_in_kit', title: 'Draft in Kit', annotations: { title: 'Draft in Kit', ...WRITE },
    description: 'Put an email in Kit as a draft, or bring a written email’s waiting draft up to date. A draft only: nothing goes out until someone reviews it and sends it from Kit, and the other reviewers hear it’s waiting. A written email by its id, or one of the site’s emails by its key.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'A written email’s id' }, key: KEY }, additionalProperties: false } },
]);

const HANDLERS = {
  find_kids: (env, a) => findKids(env, a), get_kid: (env, a) => getKid(env, a),
  find_events: (env, a) => findEvents(env, a), get_event: (env, a) => getEvent(env, a),
  list_written_emails: (env) => listWritten(env), get_written_email: (env, a) => getWritten(env, a),
  save_written_email: saveWritten, get_email_words: (env, a) => getWords(env, a), set_email_words: setWords,
  send_me_a_test: sendTest, draft_in_kit: draftInKit,
};

/** Run one tool for the person signed in. Never throws: a failure comes back as the tool's error, in words. */
export async function callTool(env, name, args, me) {
  const run = HANDLERS[name];
  if (!run) return refuse(`There’s no tool called ${name}.`);
  try {
    return await run(env, args && typeof args === 'object' ? args : {}, me);
  } catch (err) {
    console.error('[mcp]', name, err.message);
    return refuse(`That didn’t work (${err.message}). Try again in a minute.`);
  }
}

/** What Claude is told about this connection, once */
export function serverInstructions(now = Date.now()) {
  const month = monthBefore(dayIn(now));
  return [
    'This is the website of Sunshine on a Ranney Day (SOARD), a nonprofit that builds dream bedrooms and accessible bathrooms for kids with special needs in the Atlanta area.',
    'Use it to write emails in SOARD’s own layout and to change the words of the emails the site drafts by itself. Everything goes to Kit as a draft only; a person reviews and sends it from Kit.',
    'Look things up first (find_kids, get_kid, find_events, get_event) and use only what they say: never invent facts, names, dates or numbers about a family.',
    `This month’s Monthly Impact (for the month just ended) is ${monthlyKey(month)}.`,
    'Write the way SOARD does: warm, plain and specific, no em dashes. Say “kids” and “families”.',
  ].join(' ');
}
