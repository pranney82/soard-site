/**
 * The first paragraph of a kid's story, as plain words. Bios are HTML on newer
 * kid pages and plain text with blank lines on older ones. A long paragraph
 * ends on a whole sentence, never mid-word.
 */
const ENTITIES: Record<string, string> = { amp: '&', nbsp: ' ', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };

const NOT_AN_END = /(?:\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Rev|Mt)|\b[A-Z])\.$/;

export function storyLead(bio: string | null | undefined, max = 420): string {
  const words = String(bio || '')
    .replace(/<\/p\s*>\s*(<p[^>]*>)?/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d{1,6});/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (all, name) => ENTITIES[name.toLowerCase()] ?? all);
  const first = words.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  // The last real sentence end: "Ms." and "J." don't count
  let end = -1;
  for (const m of cut.matchAll(/[.!?](?=\s)/g)) if (!NOT_AN_END.test(cut.slice(0, (m.index ?? 0) + 1))) end = m.index ?? -1;
  return end >= max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}
