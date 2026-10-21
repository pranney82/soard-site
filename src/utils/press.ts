/**
 * Press stories and outlets on the public pages. Mirrors
 * public/admin/press-shared.js (linkFor, outletCount, outletNameFor, inStrip)
 * so the admin, its Preview and the site agree; tests/press-admin.test.mjs
 * checks the two give the same answers.
 */

type Story = { outlet?: string; outletLogo?: string; url?: string; archiveUrl?: string | null; linkGone?: string | null; publishStatus?: string; kids?: string[]; date?: string; title?: string; category?: string };
type Outlet = { name: string; slug: string; logo?: string; strip?: boolean };

const plain = (s: string | null | undefined) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** One key per outlet name ("The Atlanta Journal-Constitution" = "Atlanta Journal-Constitution") */
export function outletKey(name: string | null | undefined): string {
  return plain(name).toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/\.(com|org|net|tv|news)\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '');
}

export const isPublished = (s: Story) => s.publishStatus !== 'draft';
/** Where a reader goes: the story, or its archived copy once the outlet took it down (null: no link) */
export const linkFor = (s: Story): string | null => (s.linkGone ? (s.archiveUrl || null) : (s.url || null));
export const isArchived = (s: Story) => !!(s.linkGone && s.archiveUrl);
/** The outlet's name from its record when the story is linked to one */
export const outletNameFor = (s: Story, outlets: Map<string, Outlet>) => (s.outletLogo && outlets.get(s.outletLogo)?.name) || plain(s.outlet);
/** Outlets on the page's count: by outlet record when it exists, else by name */
export const outletCount = (stories: Story[], outlets: Map<string, Outlet>) => new Set(stories.map((p) => (p.outletLogo && outlets.has(p.outletLogo) ? `o:${p.outletLogo}` : `n:${outletKey(p.outlet)}`))).size;
/** In the "As Featured" strip: a logo, and not switched off (older records have no switch) */
export const inStrip = (o: Outlet) => !!(o.logo && o.strip !== false);
