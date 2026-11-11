/**
 * A hero's words, written once. The page draws them part by part in its own
 * template (so its scoped styles reach the italic word, the bold words and the
 * line break, as they did when the words were written inline), and its share
 * card reads the same parts as HTML (heroHtml).
 *
 *   const hero = { title: ['A room can change', BR, "a child's ", { em: 'entire' }, ' life.'] };
 *   <h1>{hero.title.map((p) => typeof p === 'string' ? p : 'em' in p ? <em>{p.em}</em> : <br/>)}</h1>
 */
export type HeroPart = string | { em: string } | { strong: string } | { a: string } | { br: true };

export const BR = { br: true } as const;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The parts as HTML, for the share card (a link is just its words there) */
export function heroHtml(parts: HeroPart[] | string): string {
  if (typeof parts === 'string') return parts;
  return parts.map((p) => {
    if (typeof p === 'string') return esc(p);
    if ('em' in p) return `<em>${esc(p.em)}</em>`;
    if ('strong' in p) return `<strong>${esc(p.strong)}</strong>`;
    if ('a' in p) return esc(p.a);
    return '<br>';
  }).join('');
}
