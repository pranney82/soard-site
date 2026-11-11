/**
 * The SOARD connection for Claude: what every tool shares (../_mcp-tools.js lists them).
 *
 * A tool reuses the admin's own code, never a copy of it: either the function a
 * screen reads (checkinView, checksView…), or, where the work lives inside an
 * admin route, that route itself, run here as the person signed in (adminCall).
 * The connection has already held them to the admin's staff rule (../../mcp.js),
 * which is all the admin's own middleware hands a staff request: their email.
 */

import { SITE_URL } from '../_reveal-invite-email.js';

export { SITE_URL };
export const VIA = ' (via Claude)';
export const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;
export const adminUrl = (hash) => `${SITE_URL}/admin/${hash}`;
export const isoDay = (iso) => (iso ? String(iso).slice(0, 10) : null);
export const dollars = (cents) => (Number.isFinite(Number(cents)) ? Math.round(Number(cents)) / 100 : null);
export const words = (s, max = 400) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Claude.ai takes about 150,000 characters of one answer; this stays well inside it */
export const MAX_ANSWER = 120000;

/**
 * A tool's answer: compact JSON as text (what Claude reads) and the same as structured content.
 * Too big for one answer: the longest lists are cut and the answer says so, never cut mid-word.
 */
export function done(data) {
  let out = data;
  let text = JSON.stringify(out);
  for (let i = 0; text.length > MAX_ANSWER && i < 12; i++) {
    out = shrink(out);
    text = JSON.stringify(out);
  }
  if (text.length > MAX_ANSWER) {
    out = { tooMuch: 'That’s more than one answer can carry. Ask for less: a narrower search, fewer days, or one item.' };
    text = JSON.stringify(out);
  }
  return { content: [{ type: 'text', text }], structuredContent: out };
}

/** The longest list anywhere in it, halved, with a note of how many were left out */
function shrink(data) {
  let best = null;
  const walk = (v, path) => {
    if (Array.isArray(v)) {
      if (!best || v.length > best.v.length) best = { v, path };
      v.forEach((x, i) => walk(x, [...path, i]));
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  walk(data, []);
  if (!best || best.v.length < 2) return data;
  const copy = structuredClone(data);
  let parent = copy;
  for (const k of best.path.slice(0, -1)) parent = parent[k];
  const key = best.path[best.path.length - 1];
  const list = best.path.length ? parent[key] : copy;
  const keep = Math.ceil(list.length / 2);
  const cut = list.slice(0, keep);
  if (!best.path.length) return cut;
  parent[key] = cut;
  const note = `${String(key)}LeftOut`;
  if (parent && typeof parent === 'object' && !Array.isArray(parent)) parent[note] = (Number(parent[note]) || 0) + (list.length - keep);
  return copy;
}

/** A tool that couldn't do it says why, in words a person can act on */
export const refuse = (why) => ({ content: [{ type: 'text', text: why }], isError: true });

/** Annotations, as Claude's connector rules ask every tool to declare them */
export const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
export const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });

/**
 * Run an admin route here, as the person signed in: the same code, the same checks, the same records as the
 * admin's own screen. → { status, ok, data }
 */
export async function adminCall(handler, ctx, path, { method = 'GET', body } = {}) {
  const request = new Request(`${SITE_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await handler({
    request, env: ctx.env, params: {}, data: { userEmail: ctx.me, ...(ctx.via ? { via: ctx.via } : {}) },
    waitUntil: ctx.waitUntil || ((p) => { Promise.resolve(p).catch(() => {}); }),
    next: () => new Response('Not found', { status: 404 }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok && data?.success !== false && data?.ok !== false, data };
}

// ── Checking what Claude sent against the tool's own schema ────────────────

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (want, v) => {
  const t = typeOf(v);
  return want === t || (want === 'number' && t === 'integer');
};

/**
 * The JSON Schema keywords these tools use (type, properties, required, additionalProperties: false, enum,
 * items, minimum/maximum, minLength/maxLength, maxItems, pattern) → the first problem in plain words, or null
 */
export function problemWith(schema, value, at = '') {
  if (!schema || typeof schema !== 'object') return null;
  const name = at || 'the input';
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => fits(t, value))) return `${name} should be ${types.map((t) => (t === 'integer' ? 'a whole number' : t === 'array' ? 'a list' : t === 'object' ? 'an object' : `a ${t}`)).join(' or ')}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${name} should be one of: ${schema.enum.join(', ')}`;
  if (typeof value === 'string') {
    if (schema.minLength && value.length < schema.minLength) return `${name} is empty`;
    if (schema.maxLength && value.length > schema.maxLength) return `${name} is longer than ${schema.maxLength} characters`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${name} isn’t in the right form`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${name} should be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${name} should be at most ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (schema.maxItems && value.length > schema.maxItems) return `${name} has more than ${schema.maxItems} items`;
    if (schema.items) for (let i = 0; i < value.length; i++) {
      const p = problemWith(schema.items, value[i], `${name}[${i}]`);
      if (p) return p;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (value[k] === undefined) return `${at ? `${at}.` : ''}${k} is needed`;
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) {
        const p = problemWith(props[k], v, at ? `${at}.${k}` : k);
        if (p) return p;
      } else if (schema.additionalProperties === false) return `${at ? `${at}.` : ''}${k} isn’t one of this tool’s inputs (it takes ${Object.keys(props).join(', ') || 'none'})`;
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const p = problemWith(schema.additionalProperties, v, at ? `${at}.${k}` : k);
        if (p) return p;
      }
    }
  }
  return null;
}
