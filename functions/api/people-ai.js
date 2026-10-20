/**
 * POST /api/people-ai
 * "Tidy to house style" for a Leadership bio: a suggested rewrite the editor
 * shows next to the original. Nothing is saved here; someone has to use it.
 *   { bio, name, title, organization, group, role } → { suggestion, words }
 *
 * Workers AI (the AI binding, like /api/generate). Admin-only.
 * House style: third person, 40 to 120 words, only facts from the original,
 * no pronouns the original doesn't give (and no first name repeated to dodge
 * them), no em or en dashes, no stock phrases. A draft that breaks those gets
 * one corrected pass, checked by bioProblems().
 */
const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export const STYLE_RULES = [
  'Write in the third person. Use their full name once, near the start, and only their first name after that.',
  'If the original never says which pronouns they use, never use he, she, him, her, his or hers. Do not repeat the first name to get around it: use the first name at most twice in the whole bio. Instead, join related facts into one sentence, or make their company, role or work the subject of the sentence.',
  'Keep it between 40 and 120 words, in one or two short paragraphs. If the original has few facts, a shorter bio is fine: never pad it.',
  'Use only facts that are in the original. Never invent titles, dates, numbers, places, family details, feelings or achievements.',
  'Plain, warm and specific. Vary how sentences begin. US English.',
  'No em dashes or en dashes; use commas or periods. No exclamation marks.',
  'Avoid stock phrases such as "journey", "passionate about", "dedicated to", "testament", "truly", "giving back", "make a difference", "heartwarming", "life-changing".',
];

// The style, shown on someone else (the model takes none of these facts)
const EXAMPLE = `Original: "jane owns a bakery in decatur. she has volunteered at our builds since 2018 and her bakery caters every reveal party"
Rewrite: "Jane Doe owns a bakery in Decatur and has volunteered at SOARD builds since 2018. The bakery also caters every reveal party."`;

/** The prompt (exported so the tests can check what the model is asked) */
export function bioPrompt({ bio, name, title, organization, group, role }) {
  const who = [name && `Name: ${name}`, title && `Role at SOARD: ${title}`, organization && `Organization: ${organization}`,
    `Section: ${group === 'board' ? 'Board of Directors' : role === 'founder' ? 'Co-Founder' : 'Our Team'}`].filter(Boolean).join('\n');
  return `You edit short bios for the Leadership page of Sunshine on a Ranney Day (SOARD), an Atlanta nonprofit that builds dream bedrooms, accessible bathrooms and therapy rooms for children with special needs, at no cost to families.

Rewrite the bio below in the house style.
${STYLE_RULES.map((r) => `- ${r}`).join('\n')}

An example of the style, about a different person (use none of its facts):
${EXAMPLE}

${who}

Original bio:
"""
${String(bio || '').trim()}
"""

Reply with the rewritten bio only: no title, no quotes, no notes.`;
}

const GENDERED = /\b(he|she|him|her|his|hers|himself|herself)\b/i;
const STOCK = ['journey', 'passionate about', 'dedicated to', 'testament', 'truly', 'giving back', 'make a difference', 'heartwarming', 'life-changing'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a draft gets wrong against the house style, written as instructions for a second pass */
export function bioProblems(text, { name = '', original = '' } = {}) {
  const out = [];
  const t = String(text || '');
  const words = t.split(/\s+/).filter(Boolean).length;
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  if (first.length > 1) {
    const uses = (t.match(new RegExp(`\\b${esc(first)}\\b`, 'g')) || []).length;
    const most = words > 90 ? 3 : 2;
    if (uses > most) out.push(`It uses the first name "${first}" ${uses} times. Use it at most ${most} times: join sentences, or make the company, role or work the subject.`);
  }
  if (GENDERED.test(t) && !GENDERED.test(String(original || ''))) out.push('It uses he, she, his or her, but the original never says which pronouns they use. Reword so no pronoun is needed.');
  const stock = STOCK.filter((p) => t.toLowerCase().includes(p));
  if (stock.length) out.push(`Remove these stock phrases: ${stock.join(', ')}.`);
  if (t.includes('!')) out.push('Remove the exclamation marks.');
  if (words > 120) out.push(`It is ${words} words. Keep it to 120 or fewer.`);
  return out;
}

/** The second pass: the same brief, the draft, and what to fix */
export function revisePrompt(body, draft, problems) {
  return `${bioPrompt(body)}

A first draft of the rewrite was:
"""
${draft}
"""
Fix these problems in it, keeping every fact and adding none:
${problems.map((p) => `- ${p}`).join('\n')}

Reply with the corrected bio only.`;
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
    const ask = async (content) => {
      const r = await context.env.AI.run(TEXT_MODEL, { messages: [{ role: 'user', content }], max_tokens: 500, temperature: 0.4 });
      return tidyBio(typeof r?.response === 'string' ? r.response : '');
    };
    const check = (t) => bioProblems(t, { name: body.name, original: bio });
    let suggestion = await ask(bioPrompt(body));
    if (!suggestion) return Response.json({ success: false, error: 'No suggestion came back. Try again.' }, { status: 500 });
    // A draft that breaks the house style gets one corrected pass; the better of the two is shown
    let problems = check(suggestion);
    if (problems.length) {
      const second = await ask(revisePrompt(body, suggestion, problems)).catch(() => '');
      const again = second ? check(second) : null;
      if (second && again.length <= problems.length) { suggestion = second; problems = again; }
    }
    return Response.json({ success: true, suggestion, words: suggestion.split(/\s+/).filter(Boolean).length });
  } catch (err) {
    console.error('[people-ai]', err);
    return Response.json({ success: false, error: 'The writing helper didn’t answer. Try again in a minute.' }, { status: 500 });
  }
}
