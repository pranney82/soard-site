/**
 * JobTread roles that follow Partners levels (functions/api/_partner-roles.js):
 * reading SOARD's roles, their kind and permissions, and who has each.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRoles } from '../functions/api/_partner-roles.js';
import { onRequestGet } from '../functions/api/partner-roles-admin.js';

const ROLES = [
  { id: 'r-vendor', name: 'Vendor', type: 'vendor', permissions: ['readJobs', 'readFiles'], createdAt: '2024-01-01T00:00:00Z' },
  { id: 'r-sponsor', name: 'Sponsor', type: 'customer', permissions: ['readJobs'], createdAt: '2026-10-28T00:00:00Z' },
  { id: 'r-admin', name: 'Admin', type: 'internal', permissions: ['all'], createdAt: '2023-01-01T00:00:00Z' },
];
const MEMBERS = [
  ...Array.from({ length: 130 }, (_, i) => ({ isInternal: false, role: { id: 'r-vendor' }, account: i % 2 ? { type: 'vendor' } : null })),
  { isInternal: false, role: { id: 'r-sponsor' }, account: { type: 'customer' } },
  { isInternal: true, role: { id: 'r-admin' }, account: null },
  { isInternal: false, role: null, account: null },
];

function fakeJT() {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const q = JSON.parse(init.body).query;
    calls.push(q);
    const org = q.organization;
    if (org.roles) return Response.json({ organization: { roles: { nodes: ROLES } } });
    const page = Number(org.memberships.$.page || 0);
    const size = org.memberships.$.size;
    const nodes = MEMBERS.slice(page * size, (page + 1) * size);
    return Response.json({ organization: { memberships: { nodes, nextPage: (page + 1) * size < MEMBERS.length ? String(page + 1) : null } } });
  };
  return { calls, fetchImpl };
}

test('reads every role with its kind, permissions and who has it, across pages', async () => {
  const jt = fakeJT();
  const out = await readRoles({ JOBTREAD_GRANT_KEY: 'k' }, { fetchImpl: jt.fetchImpl });
  assert.equal(out.members, 133);
  assert.equal(out.noRole, 1);
  const by = Object.fromEntries(out.roles.map((r) => [r.name, r]));
  assert.deepEqual(by.Vendor, { id: 'r-vendor', name: 'Vendor', type: 'vendor', permissions: ['readFiles', 'readJobs'], createdAt: '2024-01-01T00:00:00Z', members: 130, internal: 0, accounts: { vendor: 65, customer: 0, none: 65 } });
  assert.equal(by.Sponsor.type, 'customer');
  assert.deepEqual(by.Sponsor.accounts, { vendor: 0, customer: 1, none: 0 });
  assert.equal(by.Admin.internal, 1);
  assert.equal(out.roles[0].name, 'Vendor', 'most people first');
  // Reads only: no names or emails asked for, nothing written
  for (const q of jt.calls) {
    assert.ok(q.organization, 'every call is a read');
    assert.ok(!JSON.stringify(q).includes('emailAddress'));
  }
});

test('the admin GET answers the roles, and says when JobTread isn’t connected', async () => {
  const jt = fakeJT();
  const realFetch = globalThis.fetch;
  globalThis.fetch = jt.fetchImpl;
  try {
    const res = await onRequestGet({ env: { JOBTREAD_GRANT_KEY: 'k' } });
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.roles.length, 3);
  } finally { globalThis.fetch = realFetch; }
  const off = await onRequestGet({ env: {} });
  assert.equal(off.status, 500);
  assert.match((await off.json()).error, /isn’t connected/);
});
