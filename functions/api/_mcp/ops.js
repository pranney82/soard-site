/**
 * Site → Automations through the SOARD connection: every automation and connection, and whether it's working right
 * now, exactly as the admin's map says. The map's own entries and checks (public/admin/automations.js, which its
 * tests run in Node too) read the same live facts the admin reads (automations-admin), so Claude and the map can
 * never disagree. Read only: turning an automation on or off stays in the admin.
 */

import { onRequestGet as automationsGet } from '../automations-admin.js';
import { entries, applyFacts } from '../../../public/admin/automations.js';
import { done, refuse, adminCall, adminUrl, words, READ } from './core.js';

const STATUS = { live: 'Working', test: 'Test mode', off: 'Off', attn: 'Needs attention' };
const KIND = { schedule: 'runs on a schedule', event: 'runs when something happens', visitor: 'a visitor’s action', admin: 'a staff button', link: 'a connection' };
const branchOf = (n) => { let x = n; while (x?.parent && x.parent.depth > 0) x = x.parent; return x?.depth === 1 ? x.t : null; };
const when = (v) => {
  if (!v) return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

async function automations(env, { show = 'needs', query = '' }, me, ctx) {
  const r = await adminCall(automationsGet, ctx, '/api/automations-admin');
  if (!r.ok) return refuse(r.data?.error || 'The live checks didn’t answer. Try again in a minute.');
  // Applied and read in one go (nothing awaited between), so no other request's facts can mix in
  applyFacts(r.data);
  const all = entries.map((n) => ({
    name: n.t, area: branchOf(n), status: STATUS[n.es] || n.es, kind: KIND[n.k] || null,
    why: n.es !== 'live' ? words((n.probe?.s === n.es && n.probe?.why) || n.note || '', 400) || null : null,
    ...(n.probe?.last ? { lastRan: when(n.probe.last) } : {}),
    ...(n.probe ? {} : { checked: 'From the map (the site can’t watch this one)' }),
    does: n.does ? words(n.does, 300) : null, uses: n.touches || [],
  }));
  const counts = {};
  for (const a of all) counts[a.status] = (counts[a.status] || 0) + 1;
  const q = String(query || '').trim().toLowerCase();
  const list = all.filter((a) => (q ? `${a.name} ${a.area || ''} ${a.uses.join(' ')}`.toLowerCase().includes(q) : show === 'all' || a.status !== 'Working'));
  return done({
    counts, automations: list, checkedAt: r.data.checkedAt || null,
    said: q || show === 'all' ? 'Every match, as Site → Automations shows it right now.' : 'The ones not working as they should (or off, or in test), as Site → Automations shows them right now. Turning one on or off is done there.',
    admin: adminUrl('#automations'),
  });
}

export const TOOLS = [
  { name: 'automations', title: 'Automations', annotations: { title: 'Automations', ...READ },
    description: 'Site → Automations: every automation and connection the site runs (gift alerts, reveal invites, JobTread syncs, emails, Kit, Slack…) and whether each is working right now, checked live exactly as the admin’s map checks it, with why when it isn’t. By default only those that need a look, are off or in test; all lists everything, and a word finds one (a name, an area, or a service like Zeffy).',
    inputSchema: { type: 'object', properties: { show: { type: 'string', enum: ['needs', 'all'] }, query: { type: 'string', maxLength: 120 } }, additionalProperties: false },
    run: automations },
];
