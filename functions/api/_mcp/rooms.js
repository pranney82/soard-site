/**
 * Makeovers in progress through the SOARD connection: what each kid's room still needs, whose a box is, what's on
 * its way, and the reveals coming up. All read from what the check-in page (/admin/checkin/) and Reveals show,
 * never written: checking a box in, printing and placing an order stay on the check-in page.
 */

import { checkinView, orderReads } from '../_kid-checkin.js';
import { findBox, likelyBoxes } from '../_kid-scan.js';
import { revealsAdminView } from '../reveals-admin.js';
import { done, refuse, adminUrl, SITE_URL, dollars, words, isoDay, READ } from './core.js';

const CHECKIN = `${SITE_URL}/admin/checkin/`;
const STATUS = { not: 'not ordered yet', ordered: 'ordered', partly: 'some came', here: 'here, on a shelf', out: 'gone out to the house', house: 'went straight to the house' };

const itemRow = (i) => ({
  thing: words(i.name, 160), line: i.line ? words(i.line, 120) : null, qty: i.qty ?? null, stands: STATUS[i.status] || i.status,
  ...(i.got ? { came: i.got } : {}), ...(i.shelf ? { shelf: i.shelf } : {}),
  ...(i.order?.store || i.order?.orderNumber ? { order: { store: i.order.store || null, number: i.order.orderNumber || null } } : {}),
  ...(i.also ? { alsoBought: true } : {}),
  ...(i.allowance ? { onAllowance: words(typeof i.allowance === 'string' ? i.allowance : i.allowance.line || i.allowance.lineName || 'an allowance', 120) } : {}),
});

const shipmentRow = (s, kids) => {
  const names = [...new Set((s.items || []).map((x) => kids.get(x.kid)).filter(Boolean))];
  return {
    store: s.store || null, order: s.orderNumber || null, stage: s.stage || null, expected: s.expected || null,
    ordered: isoDay(s.orderedAt), shipped: isoDay(s.shippedAt), delivered: isoDay(s.deliveredAt), checkedIn: isoDay(s.checkedAt),
    ...(s.house ? { toTheHouse: true } : {}), kids: names, things: s.unplaced ? (s.things || []).length : (s.items || []).length,
    ...(s.unplaced ? { whoseIsIt: 'Nobody’s yet: a person says whose it is on the check-in page' } : {}),
  };
};

/** The open makeovers' kids, matched by part of a name or their page name (slug) */
async function kidsMatching(env, view, kid) {
  const q = String(kid || '').trim().toLowerCase();
  if (!q) return view.kids;
  let jobId = '';
  try { jobId = (await revealsAdminView(env)).jobs?.[q] || ''; } catch { /* JobTread not answering: the names still match */ }
  return view.kids.filter((k) => k.jobId === jobId || `${k.name} ${k.short}`.toLowerCase().includes(q));
}

async function kidRoom(env, { kid }) {
  const view = await checkinView(env, { photos: false });
  const hits = await kidsMatching(env, view, kid);
  if (!hits.length) return refuse(kid ? `No open makeover matches “${kid}”. Only makeovers still in progress have things to receive; find_kids lists every kid.` : 'There are no open makeovers with things to receive right now.');
  const names = new Map(view.kids.map((k) => [k.jobId, k.short || k.name]));
  return done({
    makeovers: hits.slice(0, kid ? 4 : 30).map((k) => {
      const count = (s) => k.items.filter((i) => i.status === s).length;
      return {
        kid: k.short || k.name, job: k.name, stage: k.stage || null, projectManager: k.pm || null, shelves: k.shelves || [],
        counts: { things: k.items.length, notOrdered: count('not'), coming: count('ordered') + count('partly'), here: count('here'), atTheHouse: count('out') + count('house') },
        ...(kid ? {
          things: k.items.map(itemRow),
          allowances: (k.allowances || []).map((a) => ({ line: a.line, words: a.words, dollars: dollars(a.cents) })),
          shipments: (view.shipments || []).filter((s) => (s.items || []).some((x) => x.kid === k.jobId)).map((s) => shipmentRow(s, names)),
        } : {}),
      };
    }),
    ...(view.needsLook?.length ? { ordersNeedingALook: view.needsLook.length } : {}),
    ...(view.practice ? { note: 'The check-in page is in practice mode: nothing it records is real yet.' } : {}),
    checkIn: CHECKIN,
  });
}

async function shipments(env, { kid, show = 'coming' }) {
  const view = await checkinView(env, { photos: false });
  const names = new Map(view.kids.map((k) => [k.jobId, k.short || k.name]));
  const only = kid ? new Set((await kidsMatching(env, view, kid)).map((k) => k.jobId)) : null;
  if (only && !only.size) return refuse(`No open makeover matches “${kid}”.`);
  const list = (view.shipments || [])
    .filter((s) => !only || (s.items || []).some((x) => only.has(x.kid)))
    .filter((s) => show === 'all' || (show === 'delivered' ? s.deliveredAt && !s.checkedAt : !s.deliveredAt && !s.checkedAt));
  return done({ shipments: list.slice(0, 80).map((s) => shipmentRow(s, names)), ...(list.length > 80 ? { more: list.length - 80 } : {}), checkIn: CHECKIN });
}

/** A box's label as Claude read it (from a photo or what someone typed) → whose box it is, as the check-in scan says */
async function whoseBox(env, label) {
  const l = {
    trackingNumbers: label.trackingNumbers || [], orderNumbers: label.orderNumbers || [], po: label.po || '', store: label.store || '',
    items: label.items || [], boxTotal: Number(label.boxTotal) || 0, references: label.references || [], models: label.models || [], names: label.names || [],
  };
  if (![l.trackingNumbers, l.orderNumbers, l.items, l.references, l.models, l.names].some((a) => a.length) && !l.po && !l.store) {
    return refuse('Say what’s on the label: a tracking or order number, the store, the PO, a name or what’s inside.');
  }
  const [view, reads] = [await checkinView(env, { photos: false }), await orderReads(env.DB)];
  const names = new Map(view.kids.map((k) => [k.jobId, k.short || k.name]));
  const found = findBox(view, reads, l);
  if (found?.kid) {
    const kid = view.kids.find((k) => k.jobId === found.kid);
    const things = (kid?.items || []).filter((i) => found.items.includes(i.id)).map(itemRow);
    return done({
      whose: found.short || names.get(found.kid), sure: !!found.exact, how: found.how || null,
      ...(found.done ? { alreadyCheckedIn: true } : {}), things, shelf: kid?.shelf || null,
      next: 'Check it in on the check-in page (scan the label there, or open the kid), which prints its labels.', checkIn: CHECKIN,
    });
  }
  if (found?.unplaced) return done({ whose: null, said: 'Its order is known, but nobody has said whose it is yet. Open it on the check-in page to place it on a kid.', checkIn: CHECKIN });
  if (found?.known) return done({ whose: null, said: `The emails know this order (${found.known.store || 'a store'}${found.known.orderNumber ? ` #${found.known.orderNumber}` : ''}), but it isn’t on any kid’s list.`, checkIn: CHECKIN });
  const likely = likelyBoxes(view, reads, l);
  return done({
    whose: null, said: likely.length ? 'Nothing on it ties to one order. These are the likeliest, best first.' : 'Nothing on it matches an order or a kid’s things.',
    likely: likely.map((x) => (x.kid ? { kid: x.short || names.get(x.kid), thing: x.item?.name ? words(x.item.name, 120) : null, why: x.why } : { order: x.order, why: x.why })),
    checkIn: CHECKIN,
  });
}

async function upcomingReveals(env) {
  if (!env.JOBTREAD_GRANT_KEY) return refuse('JobTread isn’t connected, so the reveal dates can’t be read.');
  const v = await revealsAdminView(env);
  const row = (r, community) => ({
    name: r.name, date: r.date, time: r.time, confirmed: !!r.confirmed, ...(community ? { communityProject: true } : {}),
    page: community ? `${SITE_URL}/community/${r.slug}/` : `${SITE_URL}/kids/${r.slug}/`, slug: r.slug,
    admin: adminUrl(community ? `#kids/community/${r.slug}` : `#kids/${r.slug}`),
  });
  const all = [...(v.reveals || []).map((r) => row(r, false)), ...(v.projectReveals || []).map((r) => row(r, true))]
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  return done({ reveals: all, said: all.length ? 'From each makeover’s Reveal date in JobTread. Tentative ones aren’t confirmed with the family yet.' : 'No reveal dates are set in JobTread yet.', asOf: v.updatedAt || null });
}

const KID = { type: 'string', maxLength: 120, description: 'Part of the kid’s name, or their page name from find_kids' };
const strings = (d) => ({ type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 }, description: d });

export const TOOLS = [
  { name: 'kid_room', title: 'What a room still needs', annotations: { title: 'What a room still needs', ...READ },
    description: 'The open makeovers and the things each kid’s room is getting, as the check-in page shows them: not ordered yet, ordered and coming (with the store and order), here on a shelf, or at the house; their allowances, and their shipments. Name a kid for every thing; leave it out for a count per makeover.',
    inputSchema: { type: 'object', properties: { kid: KID }, additionalProperties: false },
    run: kidRoom },
  { name: 'shipments', title: 'Shipments', annotations: { title: 'Shipments', ...READ },
    description: 'Orders for the makeovers as the stores’ emails tell them: ordered, shipped (with the day expected), out for delivery, delivered, checked in. coming (the default) is what hasn’t arrived; delivered is what came and isn’t checked in yet; all is everything.',
    inputSchema: { type: 'object', properties: { kid: KID, show: { type: 'string', enum: ['coming', 'delivered', 'all'] } }, additionalProperties: false },
    run: shipments },
  { name: 'whose_box', title: 'Whose box is this', annotations: { title: 'Whose box is this', ...READ },
    description: 'Which kid a delivered box is for, the way the check-in page’s scan works it out. Read the label yourself (a photo someone shares, or what they type) and pass what’s printed; leave out what isn’t. When nothing ties it to one order, the likeliest boxes come back, best first, each with why.',
    inputSchema: { type: 'object', properties: {
      trackingNumbers: strings('Carrier tracking numbers (UPS 1Z…, FedEx, USPS, Amazon TBA…), letters and digits only'),
      orderNumbers: strings('Order numbers printed'), po: { type: 'string', maxLength: 200, description: 'What’s printed as PO, Job, Job Name or Reference' },
      store: { type: 'string', maxLength: 200, description: 'The store or sender' }, items: strings('The products named on the slip or the box'),
      models: strings('Model numbers, SKUs, item numbers'), names: strings('People’s names printed (Ship to, Attn, c/o…)'),
      references: strings('Other Ref, Invoice, Customer or Dept numbers'), boxTotal: { type: 'integer', minimum: 0, maximum: 99, description: 'From “1 of 3”: the 3' },
    }, additionalProperties: false },
    run: whoseBox },
  { name: 'upcoming_reveals', title: 'Upcoming reveals', annotations: { title: 'Upcoming reveals', ...READ },
    description: 'Every reveal coming up, kids and community projects, soonest first, from each makeover’s Reveal date in JobTread: the day, the time, and whether the family has confirmed it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: upcomingReveals },
];
