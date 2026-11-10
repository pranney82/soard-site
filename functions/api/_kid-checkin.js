/**
 * Kid items: what Clareece's check-in page shows (/admin/checkin/), built from what the site has read
 * ===========================================================================
 * Each open makeover's parts to receive (from ./_selection-parts.js), each
 * marked ordered when a store's order email was matched to it (./_order-sweep.js
 * read, ./_kid-match.js matched), plus what was bought for the kid on top of the
 * selections ("Also bought"), plus the orders a person needs to look at. Read
 * only: nothing here writes to JobTread or prints. Receiving is practice on the
 * page until the printer and the JobTread writes are tested (the plan's gates).
 */

import { matchOrder, orderGroups, templateLines, namesOf } from './_kid-match.js';

const ORDER_KINDS = new Set(['order', 'shipped', 'out', 'delivered', 'pickup']);
// Practice shelves until the real ones are set up: one a kid, in the order the kids are listed
const shelfOf = (i) => `S-${String.fromCharCode(65 + Math.floor(i / 4))}${(i % 4) + 1}`;

async function rows(DB, sql) {
  try { return (await DB.prepare(sql).all()).results || []; } catch { return []; }
}
const parse = (s, fallback) => { try { return JSON.parse(s || ''); } catch { return fallback; } };

/** "Lizzie Francis (2026)" → "Lizzie F."; a school or practice keeps its name */
export function shortName(jobName) {
  const n = namesOf(jobName);
  const words = String(jobName || '').replace(/\s*\(\d{4}\)\s*$/, '').split(/\s+/);
  return n ? `${words[0]} ${words[words.length - 1][0]}.` : words.join(' ');
}

/** The store order emails read so far, for matching: [{ mailbox, id, store, at, read }] */
export async function orderReads(DB) {
  return (await rows(DB, "SELECT mailbox, id, store, at, read FROM order_mail WHERE state = 'read'"))
    .map((r) => ({ ...r, read: parse(r.read, {}) })).filter((r) => ORDER_KINDS.has(r.read.kind));
}

/** → { practice, kids: [{ jobId, name, short, shelf, others, items }], needsLook: [...], orders: n } */
export async function checkinView(env) {
  const DB = env.DB;
  const partRows = await rows(DB, 'SELECT job_id, item_id, job_name, group_name, line_name, cents, parts, words, words_key FROM kid_parts ORDER BY job_name, group_name, line_name');
  const lines = partRows.map((r) => ({ jobId: r.job_id, itemId: r.item_id, jobName: r.job_name, lineName: r.line_name, words: r.words || '', wordsKey: r.words_key || '', parts: parse(r.parts, []) }));
  const jobs = [...new Map(lines.map((l) => [l.jobId, { id: l.jobId, name: l.jobName }])).values()];
  const dir = parse((await rows(DB, "SELECT data FROM staff_state WHERE key = 'directory'"))[0]?.data, {});
  const staff = new Set((dir.accounts || []).flatMap((a) => String(a.name || '').toLowerCase().split(/\s+/)).filter((w) => w.length > 1));
  // Who ordered, by first name: "Clareece", not her mailbox
  const firstOf = new Map((dir.accounts || []).map((a) => [String(a.email || '').toLowerCase(), String(a.name || '').split(/\s+/)[0]]));
  const templates = templateLines(lines);

  const kids = jobs.map((j, i) => ({ jobId: j.id, name: j.name, short: shortName(j.name), shelf: shelfOf(i), others: 0, items: [] }));
  const kidOf = new Map(kids.map((k) => [k.jobId, k]));
  for (const l of lines) {
    const kid = kidOf.get(l.jobId);
    if (templates.has(`${l.jobId}|${l.itemId}`)) continue;
    l.parts.forEach((p, i) => {
      if (p.source === 'buy' || p.source === 'donated') {
        // "Lighting: Wayfair Louis Parisian Globe" on the Lighting line reads as the product alone
        const name = p.name.toLowerCase().startsWith(`${l.lineName.toLowerCase()}:`) ? p.name.slice(l.lineName.length + 1).trim() || p.name : p.name;
        kid.items.push({ id: `${l.itemId}:${i}`, itemId: l.itemId, part: p.name, name, line: l.lineName, qty: p.quantity || 1, source: p.source, status: 'not', order: null });
      } else kid.others++;
    });
  }

  const reads = await orderReads(DB);
  const needsLook = [];
  let orders = 0;
  for (const g of orderGroups(reads)) {
    const m = matchOrder(g, { jobs, lines, staff, templates });
    if (!['placed', 'look'].includes(m.decision)) continue;
    orders++;
    const order = { key: g.key, store: g.store, orderNumber: g.orderNumber, at: g.at, buyer: firstOf.get(String(g.buyer || '').toLowerCase()) || String(g.buyer || '').split('@')[0] };
    const kid = m.kid ? kidOf.get(m.kid) : null;
    const looks = [];
    for (const it of m.items || []) {
      if (it.look) { looks.push(it); continue; }
      if (!kid) continue;
      if (it.alsoBought) {
        kid.items.push({ id: `also:${g.key}:${it.name}`.slice(0, 200), name: it.name, line: 'Also bought', qty: 1, source: 'buy', status: 'ordered', order });
        continue;
      }
      const target = kid.items.find((x) => x.itemId === it.itemId && x.part === it.part && x.status === 'not')
        || kid.items.find((x) => x.itemId === it.itemId && x.status === 'not');
      if (target) Object.assign(target, { status: 'ordered', order, orderedAs: it.name });
    }
    // Kids by the short names the page uses ("Peter R.")
    const shortly = (s) => kids.reduce((t, k) => t.split(String(k.name).replace(/\s*\(\d{4}\)\s*$/, '')).join(k.short), String(s || ''));
    if (looks.length || m.decision === 'look') needsLook.push({ key: g.key, ...order, po: g.po, kid: kid?.short || null, why: m.why ? shortly(m.why) : null, items: (looks.length ? looks : m.items || []).map((x) => ({ name: x.name, look: shortly(x.look || 'which kid?') })) });
  }
  for (const k of kids) k.items.sort((a, b) => (a.status === b.status ? String(a.order?.at || '').localeCompare(String(b.order?.at || '')) : a.status === 'ordered' ? -1 : 1));
  return { practice: true, kids: kids.filter((k) => k.items.length), needsLook, orders };
}
