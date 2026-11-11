/**
 * Splits text into sentences without breaking at a title or an initial
 * ("Ms. Glass", "A. J.", "Dr. Lee", "1 lb. 6 oz."). Used where a page shows
 * its first sentences (a kid's hero) and where a share card fits whole ones.
 */
const ABBREVIATION = /(?:^|[\s(“"])(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|Mt|Ft|Rev|Prof|Inc|Co|vs|No|lb|lbs|oz|[A-Z])\.$/;

export function sentences(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const part of String(text || '').trim().split(/(?<=[.!?…]["”’)]?)\s+/)) {
    current = current ? `${current} ${part}` : part;
    if (!ABBREVIATION.test(current)) { out.push(current); current = ''; }
  }
  if (current) out.push(current);
  return out.filter(Boolean);
}
