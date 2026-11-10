// Fakes for Mercury, Zeffy, Slack and the two readers, the same shapes tests/check-gifts.test.mjs uses.
// No network: every fetch goes through fakeFetch, and an unexpected host throws.
// Names and amounts are made up. Used by tests/check-gifts-edges.test.mjs
export { createD1 } from './d1-shim.mjs';
export { mirrorTransaction } from '../../functions/api/_mercury-txns.js';
export * as CG from '../../functions/api/_check-gifts.js';
export { readState, writeState } from '../../functions/api/_mercury.js';
export { writeSlackConfig } from '../../functions/api/_broadcast-notify.js';
import { createD1 } from './d1-shim.mjs';
import { mirrorTransaction } from '../../functions/api/_mercury-txns.js';
import * as CG from '../../functions/api/_check-gifts.js';
import { readState, writeState } from '../../functions/api/_mercury.js';
import { writeSlackConfig } from '../../functions/api/_broadcast-notify.js';

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
  id: TX, accountId: 'acct_check', kind: 'checkDeposit', status: 'pending', amount: 10000, counterpartyName: 'Check', createdAt: '2026-11-05T15:00:00Z', postedAt: null, categoryData: { id: 'cat_ic', name: 'Individual Contribution' },
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
    posts: [], deletes: [], slack: [], contacts: {}, postFails: null, postHook: null, postShape: null, deleteFails: false, picture: JPEG, aiCalls: 0, reading: read(), nextId: 1,
  };
}
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
export const fakeFetch = async (input, init = {}) => {
  const world = W.world;
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method || 'GET';
  if (url.hostname === 'files.mercury.test') return new Response(world.picture, { status: 200 });
  if (url.hostname.startsWith('mercury-relay')) {
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    return world.txns[id] ? json(world.txns[id]) : json({}, 404);
  }
  if (url.hostname === 'api.zeffy.com') {
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/campaigns') return json({ data: world.forms, has_more: false });
    if (path === '/payments' && method === 'GET') {
      const from = Number(url.searchParams.get('created[gte]') || 0);
      world.lastFrom = from;
      const all = world.payments.filter((p) => p.created >= from);
      const after = url.searchParams.get('starting_after');
      const start = after ? Number(after) : 0;
      const page = all.slice(start, start + 100);
      return json({ data: page, has_more: start + 100 < all.length, next_cursor: start + 100 < all.length ? String(start + 100) : null });
    }
    if (path === '/payments' && method === 'POST') {
      const body = JSON.parse(init.body);
      world.posts.push(body);
      const n = world.posts.length;
      if (world.postHook) await world.postHook(n, body);
      const fails = typeof world.postFails === 'function' ? world.postFails(n, body) : world.postFails;
      const p = hand({ id: `zeffy_pay_${world.nextId++}`, type: 'manual', amount: body.amount, campaign_id: body.campaign_id, contact: `contact_new_${n}`, description: world.forms.find((f) => f.id === body.campaign_id)?.title, buyer: { first_name: body.first_name, last_name: body.last_name, email: body.email || null }, created: dayS(body.payment_date?.slice(0, 10) || '2026-11-10') });
      if (fails === 'saved-then-lost') { world.payments.push(p); throw new DOMException('timed out', 'TimeoutError'); }
      if (fails === 'timeout') throw new DOMException('timed out', 'TimeoutError');
      if (fails === 422) return json({ error: { code: 'bad', message: 'Refused' } }, 422);
      world.payments.push(p);
      return json(world.postShape ? world.postShape(p) : p, 201);
    }
    const one = path.match(/^\/payments\/(.+)$/);
    if (one && method === 'GET') { const p = world.payments.find((x) => x.id === one[1]); return p ? json(p) : json({ error: { message: 'no' } }, 404); }
    if (one && method === 'DELETE') {
      if (world.deleteFails) return json({ error: { message: 'Not allowed' } }, 403);
      world.deletes.push(one[1]);
      world.payments = world.payments.filter((x) => x.id !== one[1]);
      return json({});
    }
    const contact = path.match(/^\/contacts\/(.+)$/);
    if (contact && method === 'GET') return json(world.contacts[contact[1]] || {}, world.contacts[contact[1]] ? 200 : 404);
    if (contact && method === 'DELETE') return json({});
  }
  if (url.hostname === 'slack.com') { world.slack.push(String(init.body || '')); return json({ ok: true, ts: `${world.slack.length}.1`, channel: 'C1' }); }
  throw new Error(`Unexpected fetch ${url}`);
};

export async function setup() {
  W.world = freshWorld();
  const DB = await createD1();
  W.env = {
    DB, MERCURY_API_TOKEN: 'm', MERCURY_RELAY_KEY: 'r', ZEFFY_API_KEY: 'z', SLACK_BOT_TOKEN: 'xoxb',
    AI: { run: async () => { W.world.aiCalls++; return { response: W.world.reading }; } },
  };
  await CG.ensureChecks(DB);
  await DB.prepare('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)').run();
  await writeSlackConfig(DB, { attention: { id: 'C_ALERTS', name: 'website-alerts', private: false } });
  await writeState(DB, 'check-gifts', { writeTest: { id: CG.WRITE_TEST, ok: true } });
  await mirrorTransaction(DB, W.world.txns[TX], { now: NOW });
  return W;
}
export const run = (now = NOW, o = {}) => CG.runChecks(W.env, { now, fetchImpl: fakeFetch, ...o });
export const rowOf = (id = TX) => W.env.DB.prepare('SELECT * FROM check_gifts WHERE id = ?').bind(id).first();
export const post = (id = TX, postedAt = '2026-11-07T15:00:00Z') => { W.world.txns[id] = { ...W.world.txns[id], status: 'sent', postedAt }; };
/** Read while pending, then posted and decided: two heartbeats */
export async function posted(now = NOW) { await run(now); post(); return run(now + 10 * MIN); }
