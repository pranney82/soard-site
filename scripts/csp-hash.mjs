/**
 * csp-hash.mjs — allow the site's inline scripts by hash, after `astro build`
 * ==========================================================================
 * The strict Content-Security-Policy (public/_headers) runs an inline <script>
 * only if its sha256 hash is listed, so an injected one never runs. This reads
 * every built page, hashes each inline script that would execute, and writes
 * the hashes into dist/_headers in place of the 'csp-hashes' placeholder,
 * per route: a page's hashes go to the policy that serves it (the most
 * specific _headers block with a placeholder; 404.html to all of them).
 * Pages with the client router can open each other without a reload, and a
 * soft navigation runs the new page's scripts under the first page's policy,
 * so their hashes go to every policy that serves one of them.
 *
 * The build fails, with the page and the fix, on:
 *   - an inline on*= handler or a javascript: URL in built HTML (the strict
 *     policy blocks both; use a listener, or data-img-fallback for images)
 *   - <script define:vars> in src/ (a new body, so a new hash, per page)
 *   - a Report-Only policy that differs from its enforced line apart from
 *     script-src and the report directives (flipping ENFORCE would change it)
 *   - any _headers line over Cloudflare's 2,000 characters
 *
 * ENFORCE: false ships the strict policy as Content-Security-Policy-Report-Only
 * beside today's enforced one. true makes the strict policy the enforced
 * Content-Security-Policy and drops the old line: going live is this one line.
 *
 * Run: node scripts/csp-hash.mjs [outDir]   (default dist; `npm run build` runs it)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENFORCE = false;

export const PLACEHOLDER = "'csp-hashes'";
export const MAX_LINE = 2000; // Cloudflare Pages ignores longer _headers lines

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RO = 'Content-Security-Policy-Report-Only';
const CSP = 'Content-Security-Policy';

// ── HTML scanning ──────────────────────────────────────────────────────

// Elements whose content is text, not markup: a "<script" or "onclick=" inside is not a tag
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
// <script type> values a browser runs (HTML's JavaScript MIME types, plus the
// other inline kinds CSP checks): anything else, e.g. JSON-LD, is data
const JS_TYPES = new Set(['', 'module', 'importmap', 'speculationrules', 'text/javascript', 'application/javascript',
  'text/ecmascript', 'application/ecmascript', 'application/x-javascript', 'application/x-ecmascript', 'text/jscript',
  'text/livescript', 'text/x-ecmascript', 'text/x-javascript', 'text/javascript1.0', 'text/javascript1.1',
  'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster', 'background', 'cite']);

/** Attributes of a start tag's inside ("a href=x onclick='y'") as [name, value] pairs */
function parseAttrs(s) {
  const out = [];
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s))) out.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']);
  return out;
}

const decodeEntities = (v) => v
  .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&colon;/gi, ':').replace(/&tab;/gi, '\t').replace(/&newline;/gi, '\n');

/**
 * One page's inline scripts and problems.
 * Returns { scripts: [{ type, body }], handlers: [...], jsUrls: [...], clientRouter }.
 */
export function scanHtml(html) {
  const scripts = [];
  const handlers = [];
  const jsUrls = [];
  let clientRouter = false;
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const tag = /^<([a-zA-Z][^\s\/>]*)/.exec(html.slice(lt, lt + 64));
    if (!tag) { i = lt + 1; continue; }
    // End of the start tag: the first > outside a quoted value
    let j = lt + tag[0].length, quote = '';
    for (; j < html.length; j++) {
      const c = html[j];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const name = tag[1].toLowerCase();
    const attrs = parseAttrs(html.slice(lt + tag[0].length, j));
    const snippet = html.slice(lt, Math.min(j + 1, lt + 160));
    for (const [a, v] of attrs) {
      if (/^on[a-z]{3,}$/.test(a)) handlers.push(`${a}= on <${name}>: ${snippet}`);
      if (URL_ATTRS.has(a) && /^javascript:/i.test(decodeEntities(v).replace(/[\u0000- ]/g, ''))) jsUrls.push(`${a}= on <${name}>: ${snippet}`);
    }
    if (name === 'meta' && attrs.some(([a, v]) => a === 'name' && v === 'astro-view-transitions-enabled')) clientRouter = true;
    i = j + 1;
    if (RAW_TEXT.has(name)) {
      // The text runs to the first matching end tag, whatever it contains
      const close = lower.indexOf(`</${name}`, i);
      const end = close < 0 ? html.length : close;
      if (name === 'script') {
        const has = (a) => attrs.some(([n]) => n === a);
        const type = (attrs.find(([n]) => n === 'type')?.[1] ?? '').trim().toLowerCase();
        if (!has('src') && JS_TYPES.has(type)) scripts.push({ type: type || 'classic', body: html.slice(i, end) });
      }
      const gt = close < 0 ? -1 : html.indexOf('>', close);
      i = gt < 0 ? html.length : gt + 1;
    }
  }
  return { scripts, handlers, jsUrls, clientRouter };
}

/** The CSP source for a script body, as the browser computes it (the parser turns CRLF and CR into LF) */
export function hashScript(body) {
  const text = body.replace(/\r\n?/g, '\n');
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

// ── _headers ───────────────────────────────────────────────────────────

/** _headers as blocks: { pattern, lines: [line indexes] } (comments and blank lines belong to no block) */
function headerBlocks(lines) {
  const blocks = [];
  let cur = null;
  lines.forEach((line, n) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    if (/^\S/.test(line)) { cur = { pattern: line.trim(), lines: [] }; blocks.push(cur); return; }
    if (cur) cur.lines.push(n);
  });
  return blocks;
}

/** True while a header line (not a comment) still has the placeholder */
export const hasPlaceholder = (text) => text.split('\n').some((l) => !l.trimStart().startsWith('#') && l.includes(PLACEHOLDER));

/** A _headers URL pattern (splat *, :placeholder) as a RegExp on the path */
export function patternRegex(pattern) {
  const path = pattern.replace(/^https?:\/\/[^/]+/, '');
  const src = path.split(/(\*|:[A-Za-z]\w*)/).map((part) =>
    part === '*' ? '.*' : part.startsWith(':') ? '[^/]+' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${src}$`);
}

/** The page URL a built file is served at */
export function urlForFile(rel) {
  const p = '/' + rel.split(sep).join('/');
  return p.endsWith('/index.html') ? p.slice(0, -'index.html'.length) : p;
}

/** Directives of a policy as Map(name → sources string), in order */
function directives(policy) {
  const map = new Map();
  for (const part of policy.split(';')) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) map.set(name.toLowerCase(), rest.join(' '));
  }
  return map;
}

/** Why a Report-Only policy isn't "the enforced one, made strict", or '' */
export function policyDrift(enforced, strict) {
  const a = directives(enforced), b = directives(strict);
  const reportOnly = new Set(['script-src-attr', 'report-uri', 'report-to']);
  const strip = (v, token) => v.split(/\s+/).filter((t) => t && t !== token).join(' ');
  for (const [name, v] of a) {
    if (!b.has(name)) return `${name} is missing from the Report-Only line`;
    const want = name === 'script-src' ? strip(v, "'unsafe-inline'") : v;
    const got = name === 'script-src' ? strip(b.get(name), PLACEHOLDER) : b.get(name);
    if (want !== got) return `${name} differs: enforced "${v}", Report-Only "${b.get(name)}"`;
  }
  for (const name of b.keys()) if (!a.has(name) && !reportOnly.has(name)) return `${name} is only on the Report-Only line`;
  if (/'unsafe-inline'/.test(b.get('script-src') || '')) return "the Report-Only script-src still has 'unsafe-inline'";
  return '';
}

/**
 * dist/_headers text with the hashes in. hashesFor(pattern) → sorted sources.
 * Returns { text, errors, policies: [{ pattern, hashes, length }] }.
 */
export function renderHeaders(text, hashesFor, { enforce = ENFORCE } = {}) {
  const lines = text.split('\n');
  const errors = [];
  const policies = [];
  const drop = new Set();
  for (const block of headerBlocks(lines)) {
    const roIdx = block.lines.find((n) => lines[n].trimStart().startsWith(`${RO}:`) && lines[n].includes(PLACEHOLDER));
    if (roIdx === undefined) continue;
    const enfIdx = block.lines.find((n) => lines[n].trimStart().startsWith(`${CSP}:`));
    const value = (n) => lines[n].slice(lines[n].indexOf(':') + 1).trim();
    if (enfIdx !== undefined) {
      const why = policyDrift(value(enfIdx), value(roIdx));
      if (why) errors.push(`_headers ${block.pattern}: ${why}`);
    }
    const hashes = hashesFor(block.pattern);
    lines[roIdx] = lines[roIdx].replace(hashes.length ? PLACEHOLDER : ` ${PLACEHOLDER}`, hashes.join(' '));
    if (enforce) {
      if (enfIdx !== undefined) drop.add(enfIdx);
      lines[roIdx] = lines[roIdx].replace(`${RO}:`, `${CSP}:`);
      for (const n of block.lines) if (lines[n].trim() === `! ${RO}`) drop.add(n);
    }
    policies.push({ pattern: block.pattern, hashes, length: lines[roIdx].length });
  }
  const out = lines.filter((_, n) => !drop.has(n));
  out.forEach((line, n) => {
    if (line.length > MAX_LINE) errors.push(`_headers line ${n + 1} is ${line.length} characters (Cloudflare's limit is ${MAX_LINE}): ${line.slice(0, 80)}…`);
  });
  if (hasPlaceholder(text) && !policies.length) errors.push(`_headers has ${PLACEHOLDER} but not on a ${RO} line`);
  return { text: out.join('\n'), errors, policies };
}

// ── The build step ─────────────────────────────────────────────────────

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** src/ files that still put per-page values into an inline script */
export function defineVarsScripts(srcDir) {
  if (!existsSync(srcDir)) return [];
  const found = [];
  for (const f of walk(srcDir)) {
    if (!f.endsWith('.astro')) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/<script\b[^>]*\bdefine:vars\b/g)) {
      found.push(`${relative(ROOT, f)}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  return found;
}

/** Hash a built site into its _headers. Returns { errors, policies, pages, scripts } and writes nothing on errors. */
export function cspHash(outDir, { enforce = ENFORCE, srcDir = join(ROOT, 'src'), write = true } = {}) {
  const headersPath = join(outDir, '_headers');
  const errors = [];
  if (!existsSync(headersPath)) return { errors: [`${headersPath} is missing (public/_headers is copied there by astro build)`], policies: [] };
  const text = readFileSync(headersPath, 'utf8');
  if (!hasPlaceholder(text)) {
    return { errors: [`${headersPath} has no ${PLACEHOLDER} placeholder: already hashed, or public/_headers lost its Report-Only lines`], policies: [] };
  }
  const lines = text.split('\n');
  const patterns = headerBlocks(lines)
    .filter((b) => b.lines.some((n) => lines[n].includes(PLACEHOLDER)))
    .map((b) => ({ pattern: b.pattern, re: patternRegex(b.pattern) }));

  for (const where of defineVarsScripts(srcDir)) {
    errors.push(`${where}: <script define:vars> gives every page its own inline script, which no hash list can keep up with. Put the values in data- attributes and read them in a plain script.`);
  }

  const byPolicy = new Map(patterns.map((p) => [p.pattern, new Set()]));
  const pagesBy = new Map(patterns.map((p) => [p.pattern, 0]));
  const routerHashes = new Set();
  const routerPolicies = new Set();
  let pages = 0, scripts = 0;
  for (const file of walk(outDir)) {
    if (!file.endsWith('.html')) continue;
    pages++;
    const rel = relative(outDir, file);
    const url = urlForFile(rel);
    const scan = scanHtml(readFileSync(file, 'utf8'));
    for (const h of scan.handlers) errors.push(`${rel}: inline event handler ${h}\n    The strict CSP blocks these. Use addEventListener in a script; for a broken-image fallback use data-img-fallback (src/layouts/BaseLayout.astro).`);
    for (const h of scan.jsUrls) errors.push(`${rel}: javascript: URL in ${h}`);
    // 404.html answers any missing path, under whichever policy that path has
    const served = rel === '404.html'
      ? patterns
      : [patterns.filter((p) => p.re.test(url)).sort((a, b) => b.pattern.length - a.pattern.length)[0]].filter(Boolean);
    for (const p of served) pagesBy.set(p.pattern, pagesBy.get(p.pattern) + 1);
    for (const s of scan.scripts) {
      scripts++;
      const h = hashScript(s.body);
      for (const p of served) byPolicy.get(p.pattern).add(h);
      if (scan.clientRouter) routerHashes.add(h);
    }
    if (scan.clientRouter) for (const p of served) routerPolicies.add(p.pattern);
  }
  for (const p of routerPolicies) for (const h of routerHashes) byPolicy.get(p).add(h);

  const rendered = renderHeaders(text, (pattern) => [...(byPolicy.get(pattern) || [])].sort(), { enforce });
  errors.push(...rendered.errors);
  if (!errors.length && write) writeFileSync(headersPath, rendered.text);
  const policies = rendered.policies.map((p) => ({ ...p, pages: pagesBy.get(p.pattern) || 0 }));
  return { errors, policies, pages, scripts };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = process.argv[2] || join(ROOT, 'dist');
  const { errors, policies, pages, scripts } = cspHash(outDir);
  if (errors.length) {
    console.error(`\n[csp-hash] build failed: ${errors.length} problem${errors.length === 1 ? '' : 's'}\n`);
    for (const e of errors.slice(0, 40)) console.error(`  - ${e}`);
    if (errors.length > 40) console.error(`  … and ${errors.length - 40} more`);
    process.exit(1);
  }
  console.log(`[csp-hash] ${pages} pages, ${scripts} inline scripts; strict policy ${ENFORCE ? 'ENFORCED' : 'report-only'}`);
  for (const p of policies) console.log(`  ${p.pattern.padEnd(14)} ${String(p.pages).padStart(4)} pages, ${String(p.hashes.length).padStart(2)} hashes, line ${p.length}/${MAX_LINE} chars`);
}
