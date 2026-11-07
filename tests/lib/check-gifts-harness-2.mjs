// Fakes for Mercury, Zeffy, Slack and the readers, for break-it round 2 (Nov 7 2026). No network: an unexpected host throws.
// Zeffy here behaves the way its spec says: POST /payments with an email finds the contact holding that email or makes one
// holding it; without one it makes a new contact. PATCH /contacts/:id changes only what it's given. Every request can be
// held by a hook (world.hook) so a test can put another run in between two of the site's calls.
// Names and amounts are made up. Used by tests/check-gifts-edges-2.test.mjs
import { createD1 } from './d1-shim.mjs';
import { mirrorTransaction } from '../../functions/api/_mercury-txns.js';
import * as CG from '../../functions/api/_check-gifts.js';
import { readState, writeState } from '../../functions/api/_mercury.js';
import { writeSlackConfig } from '../../functions/api/_broadcast-notify.js';
import * as admin from '../../functions/api/checks-admin.js';
export { createD1, mirrorTransaction, CG, readState, writeState, admin };

export const NOW = Date.parse('2026-11-10T16:00:00Z');
export const MIN = 60e3;
export const DAY = 86400e3;
export const dayS = (d) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 1000);
export const TX = 'tx_1';

export const hand = (o = {}) => ({
  id: 'zp_hand', object: 'payment', created: dayS('2026-11-04'), amount: 1000000, currency: 'usd', status: 'succeeded', type: 'manual', refund_status: 'none', refunds: [],
  description: 'Help Build a Brighter Home', contact: 'contact_1', payment_method: { type: 'cheque', brand: null, last4: null },
  buyer: { email: null, first_name: 'Pine', last_name: 'Foundation', is_corporate: false, company_name: null, address: null }, campaign_id: 'form_home', receipt_url: null, metadata: {}, ...o,
});
export const read = (o = {}) => ({ payer: 'Pine Foundation', remitter: '', cashiersCheck: false, payee: 'Sunshine On A Ranney Day', date: '2026-11-03', amount: 10000, checkNumber: '1042', memo: '', ...o });
export const txn = (o = {}) => ({
  id: TX, accountId: 'acct_check', kind: 'checkDeposit', status: 'pending', amount: 10000, counterpartyName: 'Check', createdAt: '2026-11-05T15:00:00Z', postedAt: null,
  checkNumber: '1042', dashboardLink: 'https://app.mercury.com/transactions/tx_1', attachments: [{ fileName: 'front.jpg', url: 'https://files.mercury.test/front.jpg', attachmentType: 'checkImage' }], relatedTransactions: [], ...o,
});
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 217]);

export const W = { world: null, env: null };
export function freshWorld() {
  return {
    txns: { [TX]: txn() }, payments: [], forms: [
      { id: 'form_home', type: 'donation_form', status: 'active', title: 'Help Build a Brighter Home' },
      { id: 'form_grant', type: 'donation_form', status: 'active', title: 'Grant Funding 2026' },
    ],
    posts: [], patches: [], deletes: [], slack: [], contacts: {}, log: [], hook: null, mercuryDown: false, postFails: null,
    picture: JPEG, aiCalls: 0, reading: read(), nextId: 1,
  };
}
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const byEmail = (world, email) => Object.values(world.contacts).find((c) => c.email && c.email.toLowerCase() === String(email).toLowerCase());

async function zeffy(url, method, body, world) {
  const path = url.pathname.replace('/api/v1', '');
    if (path === '/campaigns') return json({ data: world.forms, has_more: false });
    if (path === '/payments' && method === 'GET') {
      const from = Number(url.searchParams.get('created[gte]') || 0);
      const all = world.payments.filter((p) => p.created >= from);
      const start = Number(url.searchParams.get('starting_after') || 0);
      const page = all.slice(start, start + 100);
      return json({ object: 'list', data: page, has_more: start + 100 < all.length, next_cursor: start + 100 < all.length ? String(start + 100) : null });
    }
    if (path === '/payments' && method === 'POST') {
      world.posts.push(body);
      if (world.postFails === 'timeout') throw new DOMException('timed out', 'TimeoutError');
      // Finds or creates the contact by email (the spec); no email, a new contact
      let owner = body.email ? byEmail(world, body.email) : null;
      if (!owner) {
        const id = `ct_new_${world.nextId++}`;
        owner = world.contacts[id] = { id, email: body.email || null, first_name: body.first_name, last_name: body.last_name, donation_count: 0 };
      }
      owner.donation_count = (owner.donation_count || 0) + 1;
      const p = hand({ id: `zeffy_pay_${world.nextId++}`, amount: body.amount, campaign_id: body.campaign_id, contact: owner.id, description: world.forms.find((f) => f.id === body.campaign_id)?.title,
        buyer: { first_name: body.first_name, last_name: body.last_name, email: body.email || null, is_corporate: false, company_name: null }, created: Math.floor(Date.parse(body.payment_date || new Date(NOW).toISOString()) / 1000) });
      world.payments.push(p);
      return json(p, 201);
    }
    const one = path.match(/^\/payments\/(.+)$/);
    if (one && method === 'GET') { const p = world.payments.find((x) => x.id === one[1]); return p ? json(p) : json({ error: { message: 'no' } }, 404); }
    if (one && method === 'DELETE') {
      const gone = world.payments.find((x) => x.id === one[1]);
      if (!gone) return json({ error: { code: 'resource_not_found', message: 'no' } }, 404);
      world.deletes.push(one[1]);
      world.payments = world.payments.filter((x) => x.id !== one[1]);
      if (world.contacts[gone.contact]) world.contacts[gone.contact].donation_count = Math.max(0, (world.contacts[gone.contact].donation_count || 1) - 1);
      return json(gone);
    }
    if (path === '/contacts' && method === 'POST') {
      const id = `ct_${world.nextId++}`;
      world.contacts[id] = { id, email: body.email || null, first_name: body.first_name, last_name: body.last_name, donation_count: 0 };
      return json(world.contacts[id], 201);
    }
    // The contact list, as the spec has it: newest pages of { data, has_more, next_cursor }
    if (path === '/contacts' && method === 'GET') return json({ data: Object.values(world.contacts), has_more: false, next_cursor: null });
    const contact = path.match(/^\/contacts\/(.+)$/);
    if (contact && method === 'GET') return world.contacts[contact[1]] ? json(world.contacts[contact[1]]) : json({ error: { message: 'no' } }, 404);
    if (contact && method === 'PATCH') {
      world.patches.push({ id: contact[1], ...body });
      const c = world.contacts[contact[1]];
      if (!c) return json({ error: { code: 'resource_not_found', message: 'no' } }, 404);
      if (body.email && byEmail(world, body.email) && byEmail(world, body.email).id !== c.id) return json({ error: { code: 'email_already_used', message: 'Email already used' } }, 409);
      Object.assign(c, body);
      return json(c);
    }
    if (contact && method === 'DELETE') { delete world.contacts[contact[1]]; return json({}); }

  return json({ error: { message: `no route ${method} ${path}` } }, 404);
}

export const fakeFetch = async (input, init = {}) => {
  const world = W.world;
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  if (url.hostname === 'files.mercury.test') return new Response(world.picture, { status: 200 });
  if (url.hostname.startsWith('mercury-relay')) {
    if (world.mercuryDown) return json({ errors: { message: 'Service Unavailable' } }, 503);
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    return world.txns[id] ? json(world.txns[id]) : json({}, 404);
  }
  if (url.hostname === 'api.zeffy.com') {
    const path = url.pathname.replace('/api/v1', '');
    world.log.push(`${method} ${path}${body?.email !== undefined ? ` email=${body.email}` : ''}`);
    if (world.hook) await world.hook({ method, path, body });
    const f = world.fail ? world.fail({ method, path, body }) : null;
    if (f === 'timeout') throw new DOMException('timed out', 'TimeoutError');
    if (typeof f === 'number') return json({ error: { code: 'x', message: `Zeffy says no (${f})` } }, f);
    const res = await zeffy(url, method, body, world);
    if (f === 'timeout-after') throw new DOMException('timed out', 'TimeoutError');
    return res;
  }
  if (url.hostname === 'slack.com') { world.slack.push(String(init.body || '')); return json({ ok: true, ts: `${world.slack.length}.1`, channel: 'C1' }); }
  throw new Error(`Unexpected fetch ${url}`);
};

export async function setup({ join = true } = {}) {
  W.world = freshWorld();
  const DB = await createD1();
  W.env = {
    DB, MERCURY_API_TOKEN: 'm', MERCURY_RELAY_KEY: 'r', ZEFFY_API_KEY: 'z', SLACK_BOT_TOKEN: 'xoxb',
    AI: { run: async () => { W.world.aiCalls++; return { response: W.world.reading }; } },
  };
  await CG.ensureChecks(DB);
  await DB.prepare('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)').run();
  await writeSlackConfig(DB, { attention: { id: 'C_ALERTS', name: 'website-alerts', private: false } });
  await writeState(DB, 'check-gifts', { writeTest: { id: CG.WRITE_TEST, ok: true, ...(join ? { join: { ok: true } } : {}) } });
  await mirrorTransaction(DB, W.world.txns[TX], { now: NOW });
  return W;
}
export const run = (now = NOW, o = {}) => CG.runChecks(W.env, { now, fetchImpl: fakeFetch, ...o });
export const rowOf = (id = TX) => W.env.DB.prepare('SELECT * FROM check_gifts WHERE id = ?').bind(id).first();
export const post = (id = TX, postedAt = '2026-11-07T15:00:00Z') => { W.world.txns[id] = { ...W.world.txns[id], status: 'sent', postedAt }; };
export async function posted(now = NOW) { await run(now); post(); return run(now + 10 * MIN); }
/** A repeat giver whose Zeffy contact has no email, learned from an earlier hand entry */
export async function noEmailGiver(contact = {}) {
  await W.env.DB.prepare('INSERT INTO check_payers (key, name, contact_id, campaign_id, updated_at) VALUES (?, ?, ?, ?, ?)').bind('pine foundation', 'Pine Foundation', 'c_pine', 'form_home', 'x').run();
  W.world.contacts.c_pine = { id: 'c_pine', email: null, first_name: 'Pine', last_name: 'Foundation', donation_count: 3, ...contact };
}
/** Zeffy contacts left holding the site's no-mail address */
export const tagged = () => Object.values(W.world.contacts).filter((c) => /@nomail\.soardcharity\.com$/i.test(c.email || ''));
export const slackSaid = () => W.world.slack.map((b) => { try { return JSON.stringify(JSON.parse(b)); } catch { return b; } }).join('\n');
