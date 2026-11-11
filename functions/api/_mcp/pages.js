/**
 * The site's pages through the SOARD connection: find one, read it, change its words (any of them, however deep: an
 * FAQ answer, a line of Our Story, a gala tier's perk), add or take out an item in one of its lists, make a new
 * page, and see what's waiting to go live. Everything the admin's editors do with words.
 *
 * A change is saved exactly as the admin saves it (save-content: the same conflict check, every version kept to
 * restore, a History entry, its follow-ups) and goes live only when someone presses Publish. Before it's saved it
 * is checked against the build's own rules (src/content/config.ts, bundled as ./content-schema.gen.js), so nothing
 * saved here can stop a Publish.
 *
 * Stays in the admin: photos, logos and videos (its uploads); every Zeffy link (Site Config → Zeffy); whether a page
 * shows on the site; a kid's, project's or partner's name (JobTread and room credits match on them); and people,
 * because adding one decides who can sign in to the board and advisory areas.
 */

import { onRequestPost as saveContent } from '../save-content.js';
import { onRequestGet as pendingChanges } from '../pending-changes.js';
import { generateSha, isSafeName, SITE_PREFIX } from '../_collections.js';
import { loadEvents } from '../_newsletter-drafts.js';
import { eventPath } from '../../../public/admin/events-shared.js';
import { collections } from './content-schema.gen.js';
import { done, refuse, adminCall, adminUrl, SITE_URL, VIA, SLUG, words, isoDay, READ, WRITE } from './core.js';

/** Each kind of page: its table, where the admin keeps it, its build rules, its name field, its public page and admin screen */
export const KINDS = Object.freeze({
  kids: { table: 'kids', dir: 'src/content/kids/', rules: 'kids', name: 'name', what: 'a kid’s makeover page', page: (s) => `/kids/${s}/`, admin: (s) => `#kids/${s}`, nameFixed: true,
    noCreate: 'A kid’s page is made when their family is Approved in Applications (from their JobTread job), and the site needs its photo, uploaded in the admin. Find theirs with find_pages and change it with edit_page.' },
  community: { table: 'community', dir: 'src/content/community/', rules: 'community', name: 'name', what: 'a community project', page: (s) => `/community/${s}/`, admin: (s) => `#kids/community/${s}`, nameFixed: true },
  events: { table: 'events', dir: 'src/content/events/', rules: 'events', name: 'title', what: 'an event', admin: (s) => `#events/${s}` },
  articles: { table: 'articles', dir: 'src/content/articles/', rules: 'articles', name: 'title', what: 'a Resources article', page: (s) => `/resources/${s}/`, admin: () => '#site' },
  press: { table: 'press', dir: 'src/content/press/', rules: 'press', name: 'title', what: 'a story on the Press page', page: () => '/publicity/', admin: () => '#press' },
  partners: { table: 'partners', dir: 'src/content/partners/', rules: 'partners', name: 'name', what: 'a partner', page: () => '/partners/', admin: () => '#partners', nameFixed: true },
  communityPartners: { table: 'community_partners', dir: 'src/content/communityPartners/', rules: 'communityPartners', name: 'name', what: 'a community partner', page: () => '/partners/', admin: () => '#partners' },
  people: { table: 'team', dir: 'src/content/team/', rules: 'team', name: 'name', what: 'a person on the team, board or Advisory Board', page: () => '/about/leadership/', admin: () => '#people', noCreate: 'Adding a person decides who can sign in to the board and advisory areas, so it’s done in People in the admin.' },
  site: { site: true, rules: 'site', what: 'a page the whole site shares (FAQ, Our Story, the home page, gala, golf…)', admin: (k) => (k === 'golf' || k === 'gala' ? `#events/${k}` : '#site'), noCreate: 'The site’s shared pages already exist: change them with edit_page.' },
});

/** The shared pages (site docs) the admin edits, by name; the admin's own lists (committees, dismissed logos) aren't pages */
export const SITE_PAGES = Object.freeze({
  faq: { name: 'FAQ', page: '/faq/' }, 'our-story': { name: 'Our Story', page: '/about/' }, settings: { name: 'Site Config (home page, contact details)', page: '/' },
  media: { name: 'Media kit (boilerplate, mission)', page: '/branding/' }, gala: { name: 'Gala page', page: '/events/gala/' }, golf: { name: 'Golf tournament page', page: '/events/golf/' },
  'financial-snapshot': { name: 'Financial snapshot', page: '/about/financials/' }, financials: { name: 'Financial documents', page: '/about/financials/' }, book: { name: 'The 15-year book', page: '/15-years/' },
});

// Never changed through the connection: what the site's bookkeeping hangs on, everywhere…
const FIXED = new Set(['slug', 'id', 'publishStatus', 'jobId', 'jobtreadJobId', 'jtJobId', 'jtId', 'sortOrder', 'createdAt', 'updatedAt', 'jsonLd', 'cfId', 'kind', 'type']);
// …and on each kind, what JobTread, room credits and sign-ins hang on (a gala tier's status or a golf sponsor are just words)
const FIXED_ON = {
  kids: ['designers', 'sponsors', 'partnerLogos', 'year', 'status'], community: ['designers', 'sponsors', 'partnerLogos', 'year', 'status'],
  people: ['group', 'groups', 'seat', 'role', 'roles', 'committees', 'status', 'email', 'phone'], partners: ['tier', 'level'],
};
const fixedFor = (kind) => (k) => FIXED.has(k) || (FIXED_ON[kind] || []).includes(k);
const MEDIA = /image|photo|logo|video|stream|avatar|thumb|gallery|^og|icon|cover|^images$|plans/i;
// Every Zeffy link is Site Config → Zeffy's (a kid's give link, an event's tickets): never a page edit
const GIVING = /fundrais|ticket|donat|zeffy/i;
// Words on a picture (its description) are words: they may change even where the picture can't
const PICTURE_WORDS = new Set(['alt', 'caption', 'credit']);
const keyOk = (key, kind) => !fixedFor(kind)(key) && !MEDIA.test(key) && !GIVING.test(key) && !/slug$/i.test(key);

// The only markup page words may carry: what the admin's own editors write, with links to web pages
const TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a']);
export function markupProblem(text) {
  if (!/[<>]/.test(text)) return null;
  for (const m of text.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    const tag = m[1].toLowerCase();
    if (!TAGS.has(tag)) return `<${tag}> can’t go on a page (paragraphs, bold, italics, lists, headings and links can)`;
    const attrs = m[2].trim();
    if (!attrs || m[0].startsWith('</')) continue;
    if (tag !== 'a') return `<${tag}> takes no attributes`;
    const href = /^href\s*=\s*"(https:\/\/[^"\s<>]+|mailto:[^"\s<>]+)"(\s+(target="_blank"|rel="[a-z ]+"))*$/.exec(attrs);
    if (!href) return 'a link must be written <a href="https://…">words</a>';
  }
  const stray = text.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, '');
  if (/[<>]/.test(stray)) return 'a < or > that isn’t part of a tag: write it as a word';
  return null;
}

// ── Paths: "items[3].answer" ──────────────────────────────────────────────

export function parsePath(path) {
  if (typeof path !== 'string' || !path || path.length > 300) return null;
  const out = [];
  for (const part of path.split('.')) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)((?:\[\d{1,4}\])*)$/.exec(part);
    if (!m) return null;
    out.push(m[1]);
    for (const i of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(i[1]));
  }
  return out;
}
const pathOf = (segs) => segs.reduce((s, x) => (typeof x === 'number' ? `${s}[${x}]` : s ? `${s}.${x}` : x), '');
const at = (obj, segs) => segs.reduce((v, k) => (v == null ? undefined : v[k]), obj);
const typeOf = (v) => (Array.isArray(v) ? 'list' : v === null ? 'null' : typeof v);

/** May words at this path change? Every name on the way must be one the connection may touch (a picture's own words excepted) */
function pathOk(segs, kind) {
  const names = segs.filter((s) => typeof s === 'string');
  const last = names[names.length - 1];
  if (PICTURE_WORDS.has(last)) return names.slice(0, -1).every((k) => !fixedFor(kind)(k) && !GIVING.test(k));
  return names.every((k) => keyOk(k, kind));
}

/** Every piece of words (and number and yes/no) this page lets the connection change → { path: value } */
function leavesOf(doc, kind) {
  const out = {};
  const fixedName = KINDS[kind]?.nameFixed ? KINDS[kind].name : null;
  const walk = (v, segs) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...segs, i]));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...segs, k]);
    else if (segs.length && ['string', 'number', 'boolean'].includes(typeof v) && pathOk(segs, kind) && !(segs.length === 1 && segs[0] === fixedName)) out[pathOf(segs)] = typeof v === 'string' && v.length > 20000 ? `${v.slice(0, 20000)}…` : v;
  };
  walk(doc, []);
  return out;
}

/** Its lists that can take an item or lose one → { path: { items, of } } (of: 'words' or the fields an item has) */
function listsOf(doc, kind) {
  const out = {};
  const walk = (v, segs) => {
    if (Array.isArray(v)) {
      if (segs.length && pathOk(segs, kind)) {
        const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
        if (!v.length || objs.length === v.length || v.every((x) => typeof x === 'string')) {
          out[pathOf(segs)] = { items: v.length, of: v.length && objs.length ? [...new Set(objs.flatMap(Object.keys))].filter((k) => pathOk([...segs, 0, k], kind) || k === 'id' || k === 'order') : v.length ? 'words' : 'empty' };
        }
      }
      v.forEach((x, i) => walk(x, [...segs, i]));
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...segs, k]);
  };
  walk(doc, []);
  return out;
}

// ── The build's rules ─────────────────────────────────────────────────────

const unwrap = (s) => {
  let x = s;
  for (let i = 0; x && i < 10; i++) {
    const d = x._def;
    if (d?.innerType) x = d.innerType; else if (d?.schema) x = d.schema; else if (d?.out && d?.in) x = d.out; else break;
  }
  return x;
};
const shapeOf = (rules) => { const s = unwrap(collections[rules]?.schema); return typeof s?.shape === 'object' ? s.shape : typeof s?._def?.shape === 'function' ? s._def.shape() : null; };
const optional = (s) => s?.isOptional?.() || s?._def?.typeName === 'ZodDefault';

/** The build's choices for a field, where it has a fixed list ("national-tv", "local-tv"…) */
function choicesOf(rules) {
  const out = {};
  for (const [k, s] of Object.entries(shapeOf(rules) || {})) {
    const u = unwrap(s);
    const list = u?._def?.values || unwrap(u?._def?.type)?._def?.values;
    if (Array.isArray(list)) out[k] = [...list];
  }
  return out;
}
/** The fields the build needs on every page of a kind */
export const requiredOf = (rules) => Object.entries(shapeOf(rules) || {}).filter(([, s]) => !optional(s)).map(([k]) => k);

/** The build's word on a record → null, or what it would refuse, in a line */
function buildProblem(rules, record) {
  const r = collections[rules]?.schema?.safeParse(record);
  if (!r || r.success) return null;
  return r.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'the page'}: ${i.message}`).join('; ');
}

// ── Reading ───────────────────────────────────────────────────────────────

const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
const nameOf = (kind, d, slug) => (kind === 'site' ? SITE_PAGES[slug]?.name || slug : words(d?.[KINDS[kind].name] || d?.title || d?.name || slug || '', 120));

async function readRow(env, kind, slug) {
  if (kind === 'site') {
    if (!SITE_PAGES[slug]) return null;
    const row = await env.DB.prepare('SELECT data, updated_at FROM site_config WHERE key = ?').bind(slug).first();
    return row ? { raw: row.data, updated: row.updated_at } : null;
  }
  if (!isSafeName(slug)) return null;
  const row = await env.DB.prepare(`SELECT data, updated_at FROM ${KINDS[kind].table} WHERE slug = ?`).bind(slug).first();
  return row ? { raw: row.data, updated: row.updated_at } : null;
}

async function pageUrl(kind, slug, env) {
  if (kind === 'site') return SITE_PAGES[slug] ? `${SITE_URL}${SITE_PAGES[slug].page}` : null;
  if (kind === 'events') {
    const events = await loadEvents(env.DB).catch(() => []);
    const ev = events.find((e) => e.slug === slug);
    return ev ? `${SITE_URL}${eventPath(ev, events)}` : null;
  }
  return KINDS[kind].page ? `${SITE_URL}${KINDS[kind].page(slug)}` : null;
}

/** Top-level words other pages of this kind have, that this one could take */
async function fieldsSeen(env, kind) {
  if (kind === 'site') return [];
  const { results = [] } = await env.DB.prepare(`SELECT data FROM ${KINDS[kind].table} LIMIT 300`).all();
  const seen = new Set();
  for (const r of results) for (const [k, v] of Object.entries(parse(r.data) || {})) if (typeof v === 'string' && keyOk(k, kind) && !(KINDS[kind].nameFixed && k === KINDS[kind].name)) seen.add(k);
  return [...seen].sort();
}

/** Siblings for a new list item: the list's own items, else the same list on the kind's other pages */
async function siblingsFor(env, kind, slug, segs, doc) {
  const own = at(doc, segs);
  if (Array.isArray(own) && own.length) return own;
  const rows = kind === 'site'
    ? ((await env.DB.prepare('SELECT key AS slug, data FROM site_config').all()).results || []).filter((r) => SITE_PAGES[r.slug])
    : ((await env.DB.prepare(`SELECT slug, data FROM ${KINDS[kind].table} LIMIT 300`).all()).results || []);
  for (const r of rows) {
    if (r.slug === slug) continue;
    const list = at(parse(r.data), segs);
    if (Array.isArray(list) && list.length) return list;
  }
  return [];
}

async function findPages(env, { kind, query = '', limit = 40 }) {
  const kinds = kind ? [kind] : Object.keys(KINDS);
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  for (const k of kinds) {
    if (k === 'site') {
      const { results = [] } = await env.DB.prepare('SELECT key, updated_at FROM site_config').all();
      for (const r of results) {
        if (!SITE_PAGES[r.key]) continue;
        const name = SITE_PAGES[r.key].name;
        if (q && !`${name} ${r.key}`.toLowerCase().includes(q)) continue;
        out.push({ kind: 'site', slug: r.key, name, onTheSite: true, updated: isoDay(r.updated_at), admin: adminUrl(KINDS.site.admin(r.key)) });
      }
      continue;
    }
    const { results = [] } = await env.DB.prepare(`SELECT slug, data, updated_at FROM ${KINDS[k].table}`).all();
    for (const r of results) {
      const d = parse(r.data);
      if (!d) continue;
      const name = nameOf(k, d, r.slug);
      if (q && !`${name} ${r.slug}`.toLowerCase().includes(q)) continue;
      out.push({ kind: k, slug: r.slug, name, onTheSite: !d.publishStatus || d.publishStatus === 'published', updated: isoDay(r.updated_at), admin: adminUrl(KINDS[k].admin(r.slug)) });
    }
  }
  out.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  return done({ pages: out.slice(0, limit), ...(out.length > limit ? { more: out.length - limit } : {}) });
}

async function getPage(env, { kind, slug }) {
  const row = await readRow(env, kind, slug);
  if (!row) return refuse(`There’s no ${kind === 'site' ? 'shared page' : `${kind} page`} called ${slug}. Use find_pages to look it up.`);
  const doc = parse(row.raw);
  if (!doc) return refuse('That page’s record can’t be read. Open it in the admin.');
  const fields = leavesOf(doc, kind);
  const top = new Set(Object.keys(fields).map((p) => parsePath(p)[0]));
  const seen = await fieldsSeen(env, kind);
  for (const k of seen) if (doc[k] === null) fields[k] = '';
  return done({
    kind, slug, name: nameOf(kind, doc, slug), ...(kind === 'site' ? {} : { onTheSite: !doc.publishStatus || doc.publishStatus === 'published' }),
    version: await generateSha(row.raw), updated: isoDay(row.updated),
    fields, lists: listsOf(doc, kind), choices: choicesOf(KINDS[kind].rules),
    ...(kind === 'site' ? {} : { canAdd: seen.filter((k) => !(k in doc)) }),
    setInTheAdmin: Object.keys(doc).filter((k) => !top.has(k) && !(k in listsOf({ [k]: doc[k] }, kind)) && !(doc[k] === null && seen.includes(k))).sort(),
    page: await pageUrl(kind, slug, env), admin: adminUrl(KINDS[kind].admin(slug)),
    howToWrite: 'Change words by their path (items[3].answer, founders.paragraphs[1]). Keep each in the form it has: HTML paragraphs (<p>…</p>) stay HTML, plain stays plain; bold, italics, lists, headings and <a href="https://…"> links are fine, nothing else. Numbers stay numbers.',
  });
}

// ── Changing ──────────────────────────────────────────────────────────────

function wordsProblem(path, v) {
  if (v.length > 20000) return `${path} is longer than 20,000 characters`;
  const p = markupProblem(v);
  if (p) return `${path}: ${p}`;
  if (/zeffy\.com/i.test(v)) return 'Zeffy links are set in Site Config → Zeffy in the admin, so every one stays in one place';
  return null;
}

const kebab = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** A new list item, shaped like its siblings → { item } or { problem } */
function newItem(path, item, siblings, kind) {
  if (siblings.length && siblings.every((x) => typeof x === 'string')) {
    if (typeof item !== 'string') return { problem: `${path} holds words: add a piece of words` };
    const p = wordsProblem(path, item);
    return p ? { problem: p } : { item };
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { problem: `${path} holds items with fields: add an object` };
  const kinds = {};
  for (const s of siblings) for (const [k, v] of Object.entries(s || {})) kinds[k] = kinds[k] || typeOf(v);
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (siblings.length && !(k in kinds)) return { problem: `${path} items have ${Object.keys(kinds).join(', ')}, not ${k}` };
    if (!pathOk([k], kind) && !PICTURE_WORDS.has(k)) return { problem: `${k} is set in the admin` };
    if (!['string', 'number', 'boolean'].includes(typeof v)) return { problem: `${path}: ${k} takes ${kinds[k] === 'number' ? 'a number' : 'words'}` };
    if (kinds[k] && kinds[k] !== 'null' && kinds[k] !== typeof v) return { problem: `${path}: ${k} takes ${kinds[k] === 'number' ? 'a number' : kinds[k] === 'boolean' ? 'true or false' : 'words'}` };
    if (typeof v === 'string') { const p = wordsProblem(`${path}.${k}`, v); if (p) return { problem: p }; }
    out[k] = v;
  }
  // Its id and its place, as its siblings have them
  if (kinds.id === 'string' && !out.id) {
    const base = kebab(Object.values(out).find((v) => typeof v === 'string')) || 'item';
    let id = base;
    for (let n = 2; siblings.some((s) => s?.id === id); n++) id = `${base}-${n}`;
    out.id = id;
  }
  if (kinds.order === 'number' && typeof out.order !== 'number') out.order = Math.max(0, ...siblings.map((s) => Number(s?.order) || 0)) + 1;
  return { item: out };
}

async function editPage(env, { kind, slug, version, changes = {}, add = [], remove = [] }, me, ctx) {
  if (!Object.keys(changes).length && !add.length && !remove.length) return refuse('Say what to change: changes { path: new words }, add [{ to: list, item }] or remove [item path].');
  const row = await readRow(env, kind, slug);
  if (!row) return refuse(`There’s no ${kind === 'site' ? 'shared page' : `${kind} page`} called ${slug}. Use find_pages to look it up.`);
  if ((await generateSha(row.raw)) !== version) return refuse('Someone changed this page since you read it. Read it again with get_page and make your change on what it says now.');
  const doc = parse(row.raw);
  if (!doc) return refuse('That page’s record can’t be read. Open it in the admin.');
  const next = structuredClone(doc);
  const seen = await fieldsSeen(env, kind);
  const before = {};
  const changed = [];

  for (const [path, value] of Object.entries(changes)) {
    const segs = parsePath(path);
    if (!segs) return refuse(`${path} isn’t a path on this page. get_page lists them.`);
    if (!pathOk(segs, kind) || (KINDS[kind].nameFixed && path === KINDS[kind].name)) return refuse(`${path} is set in the admin, not here (${adminUrl(KINDS[kind].admin(slug))}).`);
    const was = at(doc, segs);
    const isNewTop = segs.length === 1 && (was === undefined || was === null) && seen.includes(segs[0]);
    if (!isNewTop && (was === undefined || was === null || typeof was === 'object')) return refuse(`${path} isn’t a piece of words on this page. get_page lists them.`);
    const want = isNewTop ? 'string' : typeof was;
    if (typeof value !== want) return refuse(`${path} takes ${want === 'number' ? 'a number' : want === 'boolean' ? 'true or false' : 'words'}.`);
    if (typeof value === 'string') { const p = wordsProblem(path, value); if (p) return refuse(`${p}.`); }
    if (was === value) continue;
    before[path] = was ?? null;
    const parent = at(next, segs.slice(0, -1));
    parent[segs[segs.length - 1]] = value;
    changed.push(path);
  }

  const added = [];
  for (const a of add) {
    const segs = parsePath(a?.to);
    const list = segs && at(next, segs);
    if (!segs || !Array.isArray(list) || !pathOk(segs, kind)) return refuse(`${a?.to} isn’t a list on this page that takes items. get_page lists them (lists).`);
    const r = newItem(a.to, a.item, await siblingsFor(env, kind, slug, segs, doc), kind);
    if (r.problem) return refuse(`${r.problem}.`);
    list.push(r.item);
    added.push(`${a.to}[${list.length - 1}]`);
  }

  const removed = [];
  const cuts = remove.map((p) => ({ p, segs: parsePath(p) }));
  for (const c of cuts) {
    const i = c.segs?.[c.segs.length - 1];
    const list = c.segs && at(doc, c.segs.slice(0, -1));
    if (!c.segs || typeof i !== 'number' || !Array.isArray(list) || i >= list.length || !pathOk(c.segs.slice(0, -1), kind)) return refuse(`${c.p} isn’t an item in one of this page’s lists.`);
  }
  // From the end of each list first, so every path still means what it meant when it was read
  for (const c of cuts.sort((a, b) => pathOf(b.segs.slice(0, -1)).localeCompare(pathOf(a.segs.slice(0, -1))) || b.segs.at(-1) - a.segs.at(-1))) {
    at(next, c.segs.slice(0, -1)).splice(c.segs.at(-1), 1);
    removed.push(c.p);
  }

  if (!changed.length && !added.length && !removed.length) return done({ saved: false, said: 'The page already says that. Nothing was changed.' });
  const problem = buildProblem(KINDS[kind].rules, next);
  if (problem) return refuse(`The site’s build would refuse this, so it wasn’t saved: ${problem}.`);
  const path = kind === 'site' ? `${SITE_PREFIX}${slug}.json` : `${KINDS[kind].dir}${slug}.json`;
  const r = await adminCall(saveContent, { ...ctx, via: VIA }, '/api/save-content', {
    method: 'POST', body: { path, content: JSON.stringify(next), message: `Update ${nameOf(kind, doc, slug)}${VIA}`, sha: version },
  });
  if (r.status === 409) return refuse(r.data?.error?.startsWith('Conflict') ? 'Someone changed this page since you read it. Read it again with get_page and make your change on what it says now.' : r.data?.error);
  if (!r.ok) return refuse(r.data?.error || 'The site didn’t save it. Try again in a minute.');
  return done({
    saved: true, changed, before, added, removed, version: r.data.sha,
    said: 'Saved in the admin, with every earlier version kept to restore. It goes live on the site when someone presses Publish in the admin.',
    admin: adminUrl(KINDS[kind].admin(slug)), page: await pageUrl(kind, slug, env),
  });
}

async function createPage(env, { kind, slug, fields = {} }, me, ctx) {
  const k = KINDS[kind];
  if (k.noCreate) return refuse(k.noCreate);
  const name = String(fields[k.name] || '').trim();
  if (!name) return refuse(`A new ${kind} page needs its ${k.name}.`);
  const s = slug || kebab(name);
  if (!SLUG.test(s) || !isSafeName(s)) return refuse('That page name (slug) can only have lowercase letters, numbers and dashes.');
  if (await env.DB.prepare(`SELECT 1 FROM ${k.table} WHERE slug = ?`).bind(s).first()) return refuse(`There’s already a ${kind} page called ${s}. Read it with get_page, or give the new one another slug.`);
  const { results = [] } = await env.DB.prepare(`SELECT slug, data FROM ${k.table}`).all();
  const twin = results.find((r) => String(parse(r.data)?.[k.name] || '').trim().toLowerCase() === name.toLowerCase() && (kind !== 'kids' || String(parse(r.data)?.year) === String(fields.year ?? parse(r.data)?.year)));
  if (twin) return refuse(`There’s already a ${kind} page for ${name} (${twin.slug}). Change that one with edit_page${kind === 'kids' ? ': approved families get their page made from JobTread' : ''}.`);
  const shape = shapeOf(k.rules) || {};
  const seen = new Set([...(await fieldsSeen(env, kind)), k.name, ...Object.keys(shape)]);
  const record = { slug: s };
  // What the build needs on every page may be given here, as long as it's words or a number (never a picture)
  const needed = new Set(requiredOf(k.rules).filter((f) => f !== 'slug' && f !== 'publishStatus' && !MEDIA.test(f)));
  for (const [f, v] of Object.entries(fields)) {
    if (f !== k.name && !keyOk(f, kind) && !needed.has(f)) return refuse(`${f} is set in the admin once the page exists.`);
    if (!seen.has(f)) return refuse(`${kind} pages don’t have ${f}. They have: ${[...seen].filter((x) => x === k.name || keyOk(x, kind) || needed.has(x)).sort().join(', ')}.`);
    if (!['string', 'number', 'boolean'].includes(typeof v)) return refuse(`${f} takes words.`);
    if (typeof v === 'string') { const p = wordsProblem(f, v); if (p) return refuse(`${p}.`); }
    record[f] = v;
  }
  // Hidden until someone shows it, wherever the build has the switch
  const hidden = 'publishStatus' in shape;
  if (hidden) record.publishStatus = 'draft';
  const problem = buildProblem(k.rules, record);
  if (problem) return refuse(`The site’s build would refuse this page, so it wasn’t made: ${problem}. Every ${kind} page needs ${requiredOf(k.rules).join(', ')}.`);
  const r = await adminCall(saveContent, { ...ctx, via: VIA }, '/api/save-content', {
    method: 'POST', body: { path: `${k.dir}${s}.json`, content: JSON.stringify(record), message: `Add ${name}${VIA}` },
  });
  if (!r.ok) return refuse(r.data?.error || 'The site didn’t save it. Try again in a minute.');
  return done({
    made: true, kind, slug: s, version: r.data.sha,
    said: hidden ? 'Made, hidden from the site. Add its photos and show it from its editor in the admin; it goes live with the next Publish.' : 'Made. It goes live on the site with the next Publish; add any photos or logo in the admin.',
    admin: adminUrl(k.admin(s)),
  });
}

async function waiting(env, _args, me, ctx) {
  const r = await adminCall(pendingChanges, ctx, '/api/pending-changes');
  if (!r.ok) return refuse(r.data?.error || 'The site didn’t answer. Try again in a minute.');
  const { changes = [], publish = {} } = r.data;
  return done({
    waiting: changes.map((c) => ({ what: c.type, slug: c.slug, name: c.name, last: c.action, at: c.at, edits: c.edits, by: c.users, state: c.state })),
    publishing: publish.active ? { since: publish.active.at || null, by: publish.active.by || null } : null,
    lastLive: publish.live?.at || null,
    ...(publish.failed ? { lastPublishFailed: true } : {}),
    said: changes.length ? 'These are saved but not on the site yet. Someone presses Publish in the admin to put them live.' : 'Everything saved is on the site.',
    admin: adminUrl('#history'),
  });
}

const KIND = { type: 'string', enum: Object.keys(KINDS), description: 'kids, community (projects), events, articles (Resources), press (the Press page), partners, communityPartners, people (team, board, Advisory Board), site (the shared pages: FAQ, Our Story, Site Config, media kit, gala, golf, financials, the 15-year book)' };
const MAKES = Object.keys(KINDS).filter((k) => !KINDS[k].noCreate);
const scalar = { type: ['string', 'number', 'boolean'] };

export const TOOLS = [
  { name: 'find_pages', title: 'Find pages', annotations: { title: 'Find pages', ...READ },
    description: 'The site’s pages that staff edit in the admin: kids’ makeover pages, community projects, events, Resources articles, Press stories, partners, community partners, people, and the shared pages (FAQ, Our Story, Site Config’s home page and contact details, the media kit, the gala and golf pages, financials, the 15-year book). Search by part of a name; newest change first.',
    inputSchema: { type: 'object', properties: { kind: KIND, query: { type: 'string', maxLength: 200, description: 'Part of a name' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
    run: findPages },
  { name: 'get_page', title: 'Read a page', annotations: { title: 'Read a page', ...READ },
    description: 'One page as the admin holds it: every piece of words it lets you change, by path (items[3].answer, founders.paragraphs[1]); its lists that take or lose items, and what an item holds; the build’s fixed choices for a field; its version (needed to change it); what’s set only in the admin; and links to the page and its editor.',
    inputSchema: { type: 'object', properties: { kind: KIND, slug: { type: 'string', maxLength: 200, description: 'From find_pages (for a shared page: faq, our-story, settings, media, gala, golf, financial-snapshot, financials, book)' } }, required: ['kind', 'slug'], additionalProperties: false },
    run: getPage },
  { name: 'edit_page', title: 'Change a page', annotations: { title: 'Change a page', ...WRITE, idempotentHint: false },
    description: 'Change a page exactly as an edit in the admin: words by their path, a new item in one of its lists (a question on the FAQ, a year on Our Story’s timeline, a perk), or an item taken out. Checked against the site’s build first, saved with every earlier version kept to restore and a History entry “via Claude”, and live once someone presses Publish. Read it with get_page first and pass its version: if someone changed it since, nothing is saved. Photos, logos, videos, Zeffy links, names JobTread matches on and whether a page shows stay in the admin.',
    inputSchema: { type: 'object', properties: {
      kind: KIND, slug: { type: 'string', maxLength: 200 }, version: { type: 'string', maxLength: 64, description: 'From get_page' },
      changes: { type: 'object', description: '{ "path": new value }: words, a number or true/false, as the field has', additionalProperties: scalar },
      add: { type: 'array', maxItems: 20, description: 'New items, each at the end of its list: { to: "items", item: { question, answer, category } } or a piece of words for a list of words', items: { type: 'object', properties: { to: { type: 'string', maxLength: 300 }, item: { type: ['object', 'string'] } }, required: ['to', 'item'], additionalProperties: false } },
      remove: { type: 'array', maxItems: 20, description: 'Items to take out, by their path as get_page read them ("items[5]")', items: { type: 'string', maxLength: 300 } },
    }, required: ['kind', 'slug', 'version'], additionalProperties: false },
    run: editPage },
  { name: 'create_page', title: 'Make a page', annotations: { title: 'Make a page', ...WRITE, idempotentHint: false },
    description: `Make a new page: ${MAKES.filter((k) => k !== 'site').join(', ')}. Its words only; checked against the site’s build first. A page with a show-on-the-site switch (a community project) starts hidden: photos and showing it are done in the admin. Every page goes live with the next Publish. What each kind needs: ${MAKES.filter((k) => k !== 'site').map((k) => `${k} (${requiredOf(KINDS[k].rules).filter((f) => f !== 'slug').join(', ')})`).join('; ')}. A kid’s page is made when their family is Approved; people are added in the admin.`,
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: Object.keys(KINDS).filter((k) => k !== 'site') }, slug: { type: 'string', maxLength: 120, pattern: '^[a-z0-9][a-z0-9-]*$', description: 'Its page name; made from its name when left out' },
      fields: { type: 'object', description: '{ field: value }, top-level words, numbers or true/false', additionalProperties: scalar },
    }, required: ['kind', 'fields'], additionalProperties: false },
    run: createPage },
  { name: 'changes_not_live', title: 'Waiting to publish', annotations: { title: 'Waiting to publish', ...READ },
    description: 'What’s been saved in the admin (by anyone, here or through Claude) but isn’t on the live site yet, and whether a Publish is under way.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: waiting },
];
