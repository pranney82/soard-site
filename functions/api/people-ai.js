/**
 * POST /api/people-ai
 * "Tidy to house style" for a Leadership bio: a suggested rewrite the editor
 * shows next to the original. Nothing is saved here; someone has to use it.
 *   { bio, name, title, organization, group, role } → { suggestion, words }
 *
 * Workers AI (the AI binding, like /api/generate). Admin-only.
 * House style: third person, 40 to 120 words, only facts from the original,
 * no pronouns the original doesn't give, no em or en dashes, no stock phrases.
 */
const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export const STYLE_RULES = [
  'Write in the third person, using their first name.',
  'If the original never says which pronouns they use, do not use he, she, him, her, his or hers: repeat the first name or reword the sentence.',
  'Keep it between 40 and 120 words, in one or two short paragraphs.',
  'Use only facts that are in the original. Never invent titles, dates, numbers, places, family details or achievements.',
  'Plain, warm and specific. US English.',
  'No em dashes or en dashes; use commas or periods. No exclamation marks.',
  'Avoid stock phrases such as "journey", "passionate about", "dedicated to", "testament", "truly", "giving back", "make a difference", "heartwarming", "life-changing".',
];

/** The prompt (exported so the tests can check what the model is asked) */
export function bioPrompt({ bio, name, title, organization, group, role }) {
  const who = [name && `Name: ${name}`, title && `Role at SOARD: ${title}`, organization && `Organization: ${organization}`,
    `Section: ${group === 'board' ? 'Board of Directors' : role === 'founder' ? 'Co-Founder' : 'Our Team'}`].filter(Boolean).join('\n');
  return `You edit short bios for the Leadership page of Sunshine on a Ranney Day (SOARD), an Atlanta nonprofit that builds dream bedrooms, accessible bathrooms and therapy rooms for children with special needs, at no cost to families.

Rewrite the bio below in the house style.
${STYLE_RULES.map((r) => `- ${r}`).join('\n')}

${who}

Original bio:
"""
${String(bio || '').trim()}
"""

Reply with the rewritten bio only: no title, no quotes, no notes.`;
}

/** Model output, tidied: no wrapping quotes or labels, no banned dashes, paragraphs kept */
export function tidyBio(s) {
  return String(s || '')
    .replace(/^\s*(rewritten bio|bio)\s*:\s*/i, '')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim())
    // A quote the model opened around the whole answer can be left at a paragraph's edge
    .map((p) => ((p.match(/["“”]/g) || []).length % 2 ? p.replace(/^["“”]\s*/, '').replace(/\s*["“”]$/, '') : p))
    .filter(Boolean).join('\n\n');
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    const bio = String(body.bio || '').trim();
    if (bio.split(/\s+/).filter(Boolean).length < 5) return Response.json({ success: false, error: 'Write a few sentences first, then tidy them.' }, { status: 400 });
    if (bio.length > 4000) return Response.json({ success: false, error: 'That’s too long to tidy. Trim it first.' }, { status: 400 });
    if (!context.env.AI) return Response.json({ success: false, error: 'The writing helper isn’t available here.' }, { status: 503 });
    const r = await context.env.AI.run(TEXT_MODEL, { messages: [{ role: 'user', content: bioPrompt(body) }], max_tokens: 500 });
    const suggestion = tidyBio(typeof r?.response === 'string' ? r.response : '');
    if (!suggestion) return Response.json({ success: false, error: 'No suggestion came back. Try again.' }, { status: 500 });
    return Response.json({ success: true, suggestion, words: suggestion.split(/\s+/).filter(Boolean).length });
  } catch (err) {
    console.error('[people-ai]', err);
    return Response.json({ success: false, error: 'The writing helper didn’t answer. Try again in a minute.' }, { status: 500 });
  }
}
