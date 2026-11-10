/**
 * The room's design, in on time for each reveal, by itself
 * =========================================================
 * Peter, Nov 10 2026: "what about the timing of getting the design docs on to
 * kids admin to be ready for their reveal?" Until now someone had to remember
 * Admin → Kids → Bring in from JobTread before every reveal, and nothing said
 * when they hadn't. Now, for every reveal JobTread has confirmed in the next
 * 30 days, the site brings in what the kid's profile doesn't have yet, from
 * the kid's JobTread job, the way that button does (designSources in
 * ./reveal-design-admin.js, and the same picks):
 *   - before photos (.BeforePics): BEFORE_SUGGESTED of them, spread across the visit
 *   - the existing and proposed drawings: each plan set's pages sorted by
 *     their titles and drawn by pdf.js in Cloudflare's Browser Rendering, the
 *     family's address painted out wherever its words are and the title block
 *     cut off (public/admin/reveal-design-draw.js, the code the button runs)
 *   - the design board
 * It only ever adds, a part at a time (the before photos; the drawings and
 * board), and never brings a part in again once it has (staff may have taken
 * it out on purpose). What staff saved is never touched. A drawing whose
 * street wasn't found among its words (a scan, or the street drawn as lines)
 * is saved without an address check, so the reveal screen and live page leave
 * it out, and staff are asked in Slack to cover it or tick that it has none.
 * Slack hears when a kid's design comes in, and 3 days and 1 day before each
 * reveal whether it's ready or what's missing.
 *
 * Each heartbeat (./broadcast-hooks.js) may start one run every 10 minutes,
 * claimed with one write so two never overlap; a run does one part for one
 * kid, soonest reveal first (Cloudflare gives it about 30 seconds). Each change
 * is a version in the kid's history (Admin → Kids → History) and the audit
 * log, as "Automatic design import". Never throws.
 */
import { cachedReveals } from './_reveals.js';
import { designSources } from './reveal-design-admin.js';
import { readConfig } from './_broadcast.js';
import { alertAdmins, adminCard, slackPost, SITE_ORIGIN } from './_broadcast-notify.js';
import { recordVersion } from './_content-history.js';
import { logAudit } from './_audit.js';
import { PLAN_KINDS, planKind, suggestBefores, addressWords, addressChecked, looksLikeFileName, isRevealed, kindFromText, BEFORE_SUGGESTED } from '../../public/admin/reveal-design.js';
import { isDocumentName, captionOf, kindFromSheet } from '../../public/admin/reveal-design-draw.js';

export const AUTO_KEY = 'reveal-design-auto';   // what it has done for each kid, and what Slack has been told
const CLAIM_KEY = 'reveal-design-auto-next';    // when the next run may start
const RUN_EVERY_MS = 10 * 60_000;
const AHEAD_MS = 30 * 24 * 3600e3;
const RETRY_MS = 6 * 3600e3;                    // a part with nothing to bring in is looked for again this long after
const DAY_MS = 24 * 3600e3;
const MAX_EDGE = 2400;                          // a drawing's long side, as the button draws it
const PDF_BASE = '/trade-partners/pdf/';        // the site's public copy of pdf.js (as ./_coi-backfill.js draws W-9s)
const PDFS_A_RUN = 2;
const BY = 'Automatic design import';
const KIND = Object.fromEntries(PLAN_KINDS.map((k) => [k.id, k]));
const DRAWING_PARTS = ['as-built', 'proposed', 'board'];

const possessive = (n) => (/s$/i.test(n) ? `${n}’` : `${n}’s`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'drawing';
const isPdf = (f) => /pdf/i.test(f?.type || '') || /\.pdf$/i.test(f?.name || '');
const isImage = (f) => /^image\//i.test(f?.type || '') || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f?.name || '');
const toBase64 = (bytes) => { let s = ''; const u = new Uint8Array(bytes); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// ── What a kid has ──────────────────────────────────────────────────

/** Which parts of the design a profile already has (staff's or brought in): { befores, as-built, proposed, board } */
export function partsOf(kid) {
  const plans = kid?.plans || [];
  return {
    befores: (kid?.beforeAfterPhotos || []).some((p) => p?.before),
    'as-built': plans.some((p) => p?.url && planKind(p) === 'as-built'),
    proposed: plans.some((p) => p?.url && planKind(p) === 'proposed'),
    board: plans.some((p) => p?.url && planKind(p) === 'board'),
  };
}

/** Every JobTread file already on the profile ("jt:<id>" or "jt:<id>#<page>"), so nothing comes in twice */
const sourcesOf = (kid) => new Set([...(kid?.plans || []), ...(kid?.beforeAfterPhotos || [])].map((x) => x?.source).filter(Boolean));

/**
 * What's next to do, soonest reveal first: { slug, name, startsAt, work: 'befores' | 'drawings', want } or null.
 * A part is wanted when the profile has none, it was never brought in for this kid, and it wasn't looked for in the
 * last RETRY_MS. reveals: the confirmed upcoming reveals; kids: slug → profile; ledger: AUTO_KEY's kids.
 */
export function nextWork(reveals, kids, ledger, now = Date.now()) {
  for (const r of reveals) {
    const kid = kids[r.slug];
    if (!kid || kid.publishStatus === 'draft' || isRevealed(kid)) continue;
    const has = partsOf(kid);
    const mine = ledger?.[r.slug] || {};
    const open = (part) => !has[part] && !mine.done?.[part] && !(Number(mine.tried?.[part]) > now - RETRY_MS);
    if (open('befores')) return { slug: r.slug, name: kid.name || r.name || '', startsAt: r.startsAt, work: 'befores', want: ['befores'] };
    const want = DRAWING_PARTS.filter(open);
    if (want.length) return { slug: r.slug, name: kid.name || r.name || '', startsAt: r.startsAt, work: 'drawings', want };
  }
  return null;
}

/** The confirmed reveals in the next 30 days, soonest first */
export function revealsAhead(upcoming, now = Date.now()) {
  return (upcoming || [])
    .filter((r) => r?.slug && r.confirmed !== false && r.startsAt && Date.parse(r.startsAt) > now && Date.parse(r.startsAt) - now <= AHEAD_MS)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

// ── Cloudflare Images ───────────────────────────────────────────────

/** Bytes up to Cloudflare Images under an id, as the editor's uploads are named → the picture's /public address */
async function uploadPicture(env, bytes, type, id, fetchImpl) {
  if (!env.CF_ACCOUNT_ID || !env.CF_IMAGES_TOKEN) throw new Error('Cloudflare Images isn’t set up (CF_ACCOUNT_ID, CF_IMAGES_TOKEN)');
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('over Cloudflare Images’ 10 MB');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), id.split('/').pop());
  form.append('id', id);
  const r = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`, { method: 'POST', headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(j.errors?.[0]?.message || `Cloudflare Images answered ${r.status}`);
  const variants = j.result?.variants || [];
  return variants.find((v) => v.endsWith('/public')) || variants[0] || `https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/${j.result.id}/public`;
}

async function fileBytes(url, fetchImpl) {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`JobTread answered ${r.status}`);
  return { bytes: new Uint8Array(await r.arrayBuffer()), type: (r.headers.get('content-type') || '').split(';')[0].trim() };
}

// ── The before photos ───────────────────────────────────────────────

async function bringBefores(env, job, src, kid, fetchImpl, now) {
  const have = sourcesOf(kid);
  const picks = suggestBefores(src.befores.filter((f) => !have.has(`jt:${f.id}`)), BEFORE_SUGGESTED);
  const pairs = [];
  for (const f of picks) {
    try {
      // JobTread's own 2048px JPEG of a photo (an iPhone's HEIC comes out as a JPEG this way)
      const got = await fileBytes(f.big || f.url, fetchImpl);
      const type = /^image\/(jpeg|png|webp|gif)$/.test(got.type) ? got.type : 'image/jpeg';
      if (!f.big && /hei[cf]/i.test(`${got.type} ${f.name}`)) continue;
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      const url = await uploadPicture(env, got.bytes, type, `kids/${job.slug}/ba-before-${now + pairs.length}-${slugOf(String(f.name).replace(/\.\w+$/, ''))}.${ext}`, fetchImpl);
      pairs.push({ before: url, after: '', room: '', beforeAlt: `${possessive(job.name || 'The child')} room before the makeover`, afterAlt: '', source: `jt:${f.id}` });
    } catch (e) {
      console.error('[design-auto] before photo', f.id, e.message);
    }
  }
  return { pairs, looked: picks.length };
}

// ── The drawings and board ──────────────────────────────────────────

/** The page's work, in Cloudflare's browser: sort a plan set's pages, draw the ones wanted, address painted out */
async function inBrowser(data, drawSrc, designSrc, base, opts) {
  const lib = await import(`${location.origin}${base}pdf.js`);
  lib.GlobalWorkerOptions.workerSrc = `${location.origin}${base}pdf.worker.js`;
  const asModule = (src) => import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const [draw, rd] = await Promise.all([asModule(drawSrc), asModule(designSrc)]);
  const task = lib.getDocument({ data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), standardFontDataUrl: `${base}standard_fonts/`, useWasm: false, enableXfa: false });
  try {
    const doc = await task.promise;
    const zeroBased = opts.sheets.some((s) => s.page === 0);
    const pages = [];
    for (let n = 1; n <= Math.min(doc.numPages, 40); n++) {
      const page = await doc.getPage(n);
      const scale = 360 / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      const content = await page.getTextContent().catch(() => ({ items: [] }));
      const title = draw.sheetTitle(content.items, viewport.transform, scale, opts.words);
      const body = content.items.map((i) => i.str || '').join(' ').replace(/\s+/g, ' ').trim();
      const sheet = opts.sheets.find((s) => s.page === (zeroBased ? n - 1 : n))?.name || '';
      const k = opts.document ? { kind: null, title: '' } : draw.kindFromSheet({ sheet, title, body }, rd.kindFromText);
      pages.push({ n, kind: k.kind, title: k.title, sheet });
    }
    // As the button starts its picks: the first existing and first proposed sheet; a file's board sheets
    const chosen = [];
    for (const kind of ['as-built', 'proposed']) {
      const p = opts.want.includes(kind) ? pages.find((x) => x.kind === kind) : null;
      if (p) chosen.push(p);
    }
    if (opts.want.includes('board')) chosen.push(...pages.filter((x) => x.kind === 'board'));
    const street = new Set(opts.streetWords);
    const out = [];
    for (const p of chosen) {
      const drawn = await draw.drawPdfPage(await doc.getPage(p.n), { longEdge: opts.maxEdge, words: opts.words });
      const done = draw.finishSheet(drawn.canvas);
      out.push({
        n: p.n, kind: p.kind, title: p.title, sheet: p.sheet, w: done.w, h: done.h, trimmed: done.trimmed,
        wiped: drawn.wiped, textLayer: drawn.textLayer, street: [...drawn.hits].some((w) => street.has(w)),
        png: done.canvas.toDataURL('image/png').split(',')[1],
      });
    }
    return { pages: pages.map(({ n, kind, title }) => ({ n, kind, title })), out };
  } finally {
    task.destroy();
  }
}

/** The design modules as text, for the browser page (from the site's own files; ctx.readAsset in tests) */
async function moduleSource(env, ctx, path) {
  if (ctx.readAsset) return ctx.readAsset(path);
  const r = await env.ASSETS.fetch(new Request(`${SITE_ORIGIN}${path}`));
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.text();
}

async function browserOf(env, ctx) {
  if (ctx.browser) return ctx.browser;
  if (ctx.launch) { ctx.browser = await ctx.launch(); return ctx.browser; }
  if (!env.BROWSER) return null;
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  ctx.browser = await puppeteer.launch(env.BROWSER, { keep_alive: 60000 });
  return ctx.browser;
}

/** One PDF's wanted sheets, drawn in the browser → { pages, out } */
async function drawSheets(env, ctx, bytes, opts) {
  const browser = await browserOf(env, ctx);
  if (!browser) throw new Error('Cloudflare’s browser isn’t available');
  const page = await browser.newPage();
  try {
    await page.setBypassCSP(true).catch(() => {});
    await page.goto(`${ctx.origin || SITE_ORIGIN}${PDF_BASE}pdf.js`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const [drawSrc, designSrc] = await Promise.all([moduleSource(env, ctx, '/admin/reveal-design-draw.js'), moduleSource(env, ctx, '/admin/reveal-design.js')]);
    return await page.evaluate(inBrowser, toBase64(bytes), drawSrc, designSrc, PDF_BASE, opts);
  } finally {
    await page.close().catch(() => {});
  }
}

async function bringDrawings(env, ctx, job, src, kid, want, fetchImpl, now) {
  const have = sourcesOf(kid);
  const words = addressWords(src.address);
  const streetWords = src.address.street ? addressWords({ street: src.address.street }) : [];
  const plans = [];
  const still = new Set(want);
  let looked = 0;
  // The plan sets, final plans first (sortFiles' order), a document (a scope of work, a letter) never
  for (const f of src.drawings.filter((x) => isPdf(x) && !isDocumentName(x.name))) {
    if (!still.size || looked >= PDFS_A_RUN) break;
    looked++;
    try {
      const { bytes } = await fileBytes(f.url, fetchImpl);
      const sheets = src.sheets.filter((s) => s.fileId === f.id);
      const got = await drawSheets(env, ctx, bytes, { words, streetWords, sheets, want: [...still], maxEdge: MAX_EDGE, document: false });
      const boards = [];
      for (const o of got.out) {
        const source = `jt:${f.id}#${o.n}`;
        if (have.has(source) || (o.kind !== 'board' && !still.has(o.kind))) continue;
        const named = o.sheet && !looksLikeFileName(o.sheet) ? o.sheet : o.title;
        const label = captionOf(named) || KIND[o.kind].long;
        const url = await uploadPicture(env, fromBase64(o.png), 'image/png', `kids/${job.slug}/plan-${now + plans.length}-${slugOf(label)}-notitle.png`, fetchImpl);
        // Wiped: the street itself was found by its words and painted out (as the button marks it). A board has no address to check
        const addressCheck = o.kind === 'board' ? null : o.street ? 'wiped' : null;
        plans.push({ url, label, type: o.kind, source, w: o.w, h: o.h, ...(addressCheck ? { addressCheck } : {}) });
        if (o.kind === 'board') boards.push(o); else still.delete(o.kind);
      }
      if (boards.length) still.delete('board');
    } catch (e) {
      console.error('[design-auto] drawing', f.id, e.message);
    }
  }
  // A design board that's a picture (a PNG from the designer), as the button guesses one
  if (still.has('board')) {
    for (const f of src.drawings.filter((x) => isImage(x) && !isDocumentName(x.name))) {
      const label = String(f.name || '').replace(/\.\w+$/, '');
      const guess = kindFromSheet({ sheet: label }, kindFromText).kind || (/png|hei[cf]/i.test(`${f.type} ${f.name}`) ? 'board' : null);
      if (guess !== 'board' || have.has(`jt:${f.id}`)) continue;
      try {
        const got = await fileBytes(/hei[cf]/i.test(`${f.type} ${f.name}`) ? (f.big || f.url) : f.url, fetchImpl);
        const type = /^image\/(jpeg|png|webp|gif)$/.test(got.type) ? got.type : 'image/jpeg';
        const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
        const url = await uploadPicture(env, got.bytes, type, `kids/${job.slug}/plan-${now + plans.length}-${slugOf(label)}.${ext}`, fetchImpl);
        plans.push({ url, label: looksLikeFileName(label) ? KIND.board.long : label.replace(/^.*?\d{4}[_\s-]+/, '') || KIND.board.long, type: 'board', source: `jt:${f.id}` });
        still.delete('board');
        break;
      } catch (e) {
        console.error('[design-auto] board', f.id, e.message);
      }
    }
  }
  return { plans, missing: [...still] };
}

// ── The record ──────────────────────────────────────────────────────

/** Adds to the kid's profile (re-read just before, so an edit made meanwhile is kept), with a version and an audit line */
async function addToKid(env, slug, { plans = [], pairs = [] }, now) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await env.DB.prepare('SELECT data, updated_at FROM kids WHERE slug = ?').bind(slug).first();
    if (!row?.data) return false;
    const before = JSON.parse(row.data);
    const have = sourcesOf(before);
    const addPlans = plans.filter((p) => !have.has(p.source));
    const addPairs = pairs.filter((p) => !have.has(p.source));
    if (!addPlans.length && !addPairs.length) return false;
    const after = { ...before, plans: [...(before.plans || []), ...addPlans], beforeAfterPhotos: [...(before.beforeAfterPhotos || []), ...addPairs] };
    const at = new Date(now).toISOString();
    const res = await env.DB.prepare('UPDATE kids SET data = ?, updated_at = ? WHERE slug = ? AND updated_at IS ?').bind(JSON.stringify(after), at, slug, row.updated_at).run();
    if (!res.meta?.changes) continue; // someone saved meanwhile: read it again
    await recordVersion(env.DB, { collection: 'kids', slug, data: after, previous: before, userEmail: BY, now: at }).catch(() => {});
    await logAudit(env.DB, {
      userEmail: BY, action: 'updated', entityType: 'kid', entitySlug: slug, entityName: after.name || slug,
      changes: [
        ...(addPairs.length ? [{ field: 'beforeAfterPhotos', from: null, to: `${plural(addPairs.length, 'before photo')} from JobTread` }] : []),
        ...(addPlans.length ? [{ field: 'plans', from: null, to: addPlans.map((p) => KIND[p.type].long).join(', ') }] : []),
      ],
      gitStatus: 'ok',
    }).catch(() => {});
    return true;
  }
  return false;
}

async function readLedger(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(AUTO_KEY).first().catch(() => null);
  try { return JSON.parse(row?.data || '{}') || {}; } catch { return {}; }
}
async function writeLedger(DB, ledger, now) {
  await DB.prepare('INSERT INTO site_config (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .bind(AUTO_KEY, JSON.stringify(ledger), new Date(now).toISOString()).run();
}

/** One run at a time, every RUN_EVERY_MS at most: one conditional write wins it */
async function claim(DB, now) {
  const next = String(now + RUN_EVERY_MS);
  const at = new Date(now).toISOString();
  const ins = await DB.prepare('INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(CLAIM_KEY, next, at).run();
  if (ins.meta?.changes) return true;
  const upd = await DB.prepare('UPDATE site_config SET data = ?, updated_at = ? WHERE key = ? AND CAST(data AS INTEGER) <= ?').bind(next, at, CLAIM_KEY, now).run();
  return !!upd.meta?.changes;
}

// ── Telling staff ───────────────────────────────────────────────────

const adminLink = (slug) => `${SITE_ORIGIN}/admin/#kids/${encodeURIComponent(slug)}`;
const whenOf = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Where a kid's design stands: what's in, what's missing, what waits on an address check */
export function standing(kid) {
  const has = partsOf(kid);
  const plans = kid?.plans || [];
  const befores = (kid?.beforeAfterPhotos || []).filter((p) => p?.before).length;
  const unchecked = plans.filter((p) => p?.url && planKind(p) !== 'board' && !addressChecked(p));
  const missing = [!has.befores && 'before photos', !has['as-built'] && 'the existing drawing', !has.proposed && 'the proposed drawing', !has.board && 'a design board'].filter(Boolean);
  const inParts = [befores && plural(befores, 'before photo'), ...['as-built', 'proposed', 'board'].map((k) => { const n = plans.filter((p) => p?.url && planKind(p) === k).length; return n ? `${n === 1 ? 'the' : n} ${KIND[k].long.toLowerCase()}${n > 1 ? 's' : ''}` : ''; })].filter(Boolean);
  return { missing, unchecked, inParts, ready: !missing.length && !unchecked.length };
}

async function tellFilled(env, job, kid, added) {
  const s = standing(kid);
  const list = [added.pairs.length && plural(added.pairs.length, 'before photo'), ...added.plans.map((p) => KIND[p.type].long.toLowerCase())].filter(Boolean);
  const lines = [`Brought in from JobTread for ${possessive(job.name)} reveal on ${whenOf(job.startsAt)}: ${list.join(', ')}.`,
    s.unchecked.length ? `${plural(s.unchecked.length, 'drawing')} didn’t show the street in its words, so it stays off the reveal screen until someone covers the address or ticks that it has none.` : '',
    `It shows on the reveal screen and live page from an hour before. Look it over in Admin → Kids.`].filter(Boolean);
  await slackPost(env, adminCard({ level: 'info', icon: '🎨', title: `${possessive(job.name)} design is in`, detail: lines.join(' '), url: adminLink(job.slug), urlLabel: `Open ${possessive(job.name)} profile` }), { kind: s.unchecked.length ? 'attention' : 'news' }).catch(() => {});
}

/** 3 days and 1 day out: ready, or exactly what's missing (to Needs attention, with the alert emails, when something is) */
async function tellStanding(env, reveals, kids, ledger, now) {
  let changed = false;
  for (const r of reveals) {
    const kid = kids[r.slug];
    if (!kid || isRevealed(kid)) continue;
    const left = Date.parse(r.startsAt) - now;
    const mark = left <= DAY_MS ? 'd1' : left <= 3 * DAY_MS ? 'd3' : null;
    if (!mark) continue;
    const mine = (ledger[r.slug] ||= {});
    mine.told ||= {};
    if (mine.told[mark] === r.startsAt) continue;
    mine.told[mark] = r.startsAt;
    changed = true;
    const s = standing(kid);
    const name = kid.name || r.name || r.slug;
    if (s.ready) {
      await slackPost(env, adminCard({ level: 'info', icon: '✅', title: `${possessive(name)} design is ready`, detail: `For the reveal on ${whenOf(r.startsAt)}: ${s.inParts.join(', ')}. It shows on the reveal screen and live page from an hour before.`, url: adminLink(r.slug), urlLabel: `Open ${possessive(name)} profile` }), { kind: 'news' }).catch(() => {});
    } else {
      const parts = [s.missing.length && `Missing: ${s.missing.join(', ')}.`, s.unchecked.length && `${plural(s.unchecked.length, 'drawing')} still need${s.unchecked.length === 1 ? 's' : ''} the address covered, or a tick that it has none.`].filter(Boolean).join(' ');
      const config = await readConfig(env.DB).catch(() => ({}));
      await alertAdmins(env, config, {
        level: 'warn', icon: '🎨', title: `${possessive(name)} design isn’t ready for the reveal`,
        detail: `${name} is revealed ${whenOf(r.startsAt)}. ${parts}`,
        fix: 'Admin → Kids → their profile → Bring in from JobTread, or add the files by hand. The site keeps looking on JobTread on its own too.',
        url: adminLink(r.slug), urlLabel: `Open ${possessive(name)} profile`,
      }).catch(() => {});
    }
  }
  return changed;
}

// ── The run ─────────────────────────────────────────────────────────

/**
 * One run: the next part for the next kid, then the 3-day and 1-day notes. ctx (tests and scripts): { fetchImpl,
 * launch (a local Puppeteer), readAsset, origin, now, force (skip the 10-minute claim), upcoming, sources (slug → what
 * designSources would say) }.
 * → { did: null | { slug, work, added, missing } }
 */
export async function runRevealDesigns(env, ctx = {}) {
  const fetchImpl = ctx.fetchImpl || fetch;
  const now = ctx.now || Date.now();
  if (!env.DB || !env.JOBTREAD_GRANT_KEY) return { did: null, skipped: 'not set up' };
  if (!ctx.force && !(await claim(env.DB, now))) return { did: null, skipped: 'not yet' };
  try {
    const upcoming = ctx.upcoming || (await cachedReveals(env, now)).upcoming;
    const reveals = revealsAhead(upcoming, now);
    if (!reveals.length) return { did: null };
    const rows = await Promise.all(reveals.map((r) => env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(r.slug).first().catch(() => null)));
    const kids = Object.fromEntries(reveals.map((r, i) => [r.slug, rows[i]?.data ? JSON.parse(rows[i].data) : null]));
    const ledger = await readLedger(env.DB);
    ledger.kids ||= {};

    let did = null;
    const job = nextWork(reveals, kids, ledger.kids, now);
    if (job) {
      const mine = (ledger.kids[job.slug] ||= {});
      mine.tried ||= {};
      mine.done ||= {};
      for (const part of job.want) mine.tried[part] = now;
      const src = ctx.sources ? await ctx.sources(job.slug) : await designSources(env, job.slug, { fetchImpl });
      let added = { plans: [], pairs: [] };
      let missing = job.want;
      if (src?.job) {
        if (job.work === 'befores') {
          const got = await bringBefores(env, job, src, kids[job.slug], fetchImpl, now);
          added.pairs = got.pairs;
          missing = got.pairs.length ? [] : ['befores'];
        } else {
          const got = await bringDrawings(env, ctx, job, src, kids[job.slug], job.want, fetchImpl, now);
          added.plans = got.plans;
          missing = got.missing;
        }
      }
      for (const part of job.want) if (!missing.includes(part)) mine.done[part] = now;
      const saved = await addToKid(env, job.slug, added, now);
      if (saved) {
        const fresh = await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(job.slug).first();
        kids[job.slug] = JSON.parse(fresh.data);
        await tellFilled(env, job, kids[job.slug], added);
      }
      did = { slug: job.slug, work: job.work, added: { befores: added.pairs.length, plans: added.plans.map((p) => p.type) }, missing, job: src?.job?.id || null };
    }
    await tellStanding(env, reveals, kids, ledger.kids, now);
    await writeLedger(env.DB, ledger, now);
    return { did };
  } catch (e) {
    console.error('[design-auto]', e.message);
    return { did: null, error: e.message };
  } finally {
    if (ctx.browser && !ctx.keepBrowser) {
      await ctx.browser.close().catch(() => {});
      ctx.browser = null;
    }
  }
}

/** The heartbeat's call (./broadcast-hooks.js): a run when it's time. Never throws */
export async function maybeRunRevealDesigns(env) {
  try { return await runRevealDesigns(env); } catch { return null; }
}
