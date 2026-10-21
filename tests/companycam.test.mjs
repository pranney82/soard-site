/**
 * CompanyCam for makeover families before they have a job
 * (functions/api/_companycam-sync.js, _companycam.js, companycam-webhook.js):
 * the project at In Review, home-visit photos copied to the JobTread customer
 * (once, with their folder, tags, captions and markup), the catch-up check,
 * the hand-over to the job (linked, moved, or the job's own project), Denied
 * and back, the signed webhook, and the problems Slack hears about.
 * All names, addresses and ids are made up.
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { ensureApplicantSchema } from '../functions/api/_applicants.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { webhookToken, signatureFor, CC_API } from '../functions/api/_companycam.js';
import {
  maybeRunCompanyCam, syncFamily, getFamilyRow, takeEvent, processFile, streetKey, copyOf, captionWords, tagIdsFor, companycamFacts, ensureCompanyCamSchema, testPicture,
  WEBHOOK_URL, WEBHOOK_SCOPES, FOLDER, VETTING_LABEL, SELF_TEST, OFFICE_ACCOUNT, REHEARSAL,
} from '../functions/api/_companycam-sync.js';
import { familyProjectId } from '../functions/api/_companycam-link.js';
import { onRequestPost as webhookPost } from '../functions/api/companycam-webhook.js';

const ORG = '22NJw42j5GLg';
const F = { status: '22P46wDp3NLd', year: '22P52xmCz3cx', types: '22P5KVgrLeXK', email: '22NJw43QvHeJ', phone: '22NJw43UauSc' };
const T0 = Date.parse('2026-10-21T15:00:00Z');
const MIN = 60 * 1000;
const at = (m) => T0 + m * MIN;

let w; let env; let realFetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function newWorld() {
  return {
    accounts: new Map(), jobs: new Map(), files: new Map(), deleted: [], uploads: 0,
    tags: [{ id: 'tagBefore', name: '.BeforePics' }, { id: 'tagExterior', name: ':Exterior' }, { id: 'tagStaff', name: 'In Kind' }],
    jtCalls: [], ccCalls: [], slack: [], slackEdits: [],
    cc: { projects: new Map(), photos: new Map(), documents: new Map(), labels: new Map(), webhooks: new Map(), uploads: new Map(), next: 9000 },
    fail: { jtUrlFetch: false, ccToken: false },
    now: T0,
  };
}
const ccId = () => String(++w.cc.next);

// ─── Fake JobTread ──────────────────────────────────────────────────

function accountNode(a) {
  const cfv = [[F.status, a.status], [F.year, a.year], ...(a.types || []).map((t) => [F.types, t])].filter(([, v]) => v != null)
    .map(([id, value]) => ({ value, customField: { id } }));
  return {
    id: a.id, name: a.name, type: 'customer', archivedAt: a.archivedAt || null, organization: { id: ORG },
    customFieldValues: { nodes: cfv },
    createdAt: new Date(T0 - 86400000).toISOString(),
    primaryLocation: a.home ? { id: `loc-${a.id}`, street: a.home.street, city: a.home.city, state: a.home.state, postalCode: a.home.postal, country: 'US', latitude: 33.9, longitude: -84.4, address: `${a.home.street}, ${a.home.city}, ${a.home.state} ${a.home.postal}`, county: null, customFieldValues: { nodes: [] } } : { id: `loc-${a.id}`, street: '', city: '', state: '', postalCode: '', country: '' },
    locations: { nodes: a.home ? [{ id: `loc-${a.id}` }] : [] },
    contacts: { nodes: a.contact ? [{ id: `c-${a.id}`, name: a.contact.name, title: '', customFieldValues: { nodes: [] } }] : [] },
    comms: { nodes: [] },
    primaryContact: a.contact ? { id: `c-${a.id}`, name: a.contact.name, customFieldValues: { nodes: [{ value: a.contact.email, customField: { id: F.email } }, { value: a.contact.phone, customField: { id: F.phone } }] } } : null,
    jobs: { nodes: [...w.jobs.values()].filter((j) => j.accountId === a.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map((j) => ({ id: j.id, name: j.name, closedOn: j.closedOn || null, createdAt: j.createdAt, companycamId: j.companycamId || null })) },
  };
}
function fileNode(f) {
  return { id: f.id, name: f.name, folder: f.folder ?? null, description: f.description ?? null, type: f.type || 'image/jpeg', url: f.url || `https://cdn.example.com/jt/${f.id}.jpg`, createdAt: f.createdAt || new Date(T0).toISOString(), fileTags: { nodes: (f.fileTagIds || []).map((id) => ({ id })) }, comments: { nodes: (f.comments || []).map((id) => ({ id })) } };
}
function jobtread(body) {
  const { query } = body;
  const { $, ...rest } = query;
  const [op] = Object.keys(rest);
  const q = rest[op];
  w.jtCalls.push({ op, args: q.$ });
  switch (op) {
    case 'account': {
      const a = w.accounts.get(q.$.id);
      if (a && q.files) {
        const folder = q.files.$?.where?.[2];
        const files = [...w.files.values()].filter((f) => f.targetId === a.id && (folder == null || f.folder === folder));
        return json({ account: { files: { nodes: files.map((f) => ({ id: f.id, description: f.description ?? null, job: f.targetType === 'job' ? { id: f.targetId } : null })) } } });
      }
      return json({ account: a ? accountNode(a) : null });
    }
    case 'organization': {
      if (q.jobs) {
        const ids = [].concat(q.jobs.$?.where?.[2] || []).map(String);
        return json({ organization: { jobs: { nodes: [...w.jobs.values()].filter((j) => ids.includes(String(j.companycamId))).map((j) => ({ companycamId: j.companycamId })) } } });
      }
      if (q.accounts) {
        const ids = [].concat(q.accounts.$?.where?.[2] || []);
        return json({ organization: { accounts: { nodes: ids.map((id) => w.accounts.get(id)).filter(Boolean).map(accountNode), nextPage: null } } });
      }
      return json({ organization: { fileTags: { nodes: w.tags } } });
    }
    case 'createAccount': {
      const id = `acctR${w.accounts.size + 1}`;
      const v = q.$.customFieldValues || {};
      w.accounts.set(id, { id, name: q.$.name, status: v[F.status] || null, year: v[F.year] || null, types: v[F.types] || [], home: null, contact: null });
      return json({ createAccount: { createdAccount: { id } } });
    }
    case 'createLocation': {
      const a = w.accounts.get(q.$.accountId);
      const [street, city, rest] = q.$.address.split(', ');
      a.home = { street, city, state: rest.split(' ')[0], postal: rest.split(' ')[1] };
      return json({ createLocation: { createdLocation: { id: `loc-${a.id}` } } });
    }
    case 'createContact': {
      w.accounts.get(q.$.accountId).contact = { name: q.$.name, email: '', phone: '' };
      return json({ createContact: { createdContact: { id: `c-${q.$.accountId}` } } });
    }
    case 'updateAccount': {
      const a = w.accounts.get(q.$.id);
      if (q.$.customFieldValues?.[F.status]) a.status = q.$.customFieldValues[F.status];
      if (q.$.archive) a.archivedAt = new Date(w.now).toISOString();
      return json({});
    }
    case 'createUploadRequest': {
      if (q.$.url && w.fail.jtUrlFetch) return new Response('could not fetch the file', { status: 400 });
      const id = `up${++w.uploads}`;
      return json({ createUploadRequest: { createdUploadRequest: { id, url: `https://uploads.example.com/jt/${id}`, method: 'PUT', headers: {} } } });
    }
    case 'createFile': {
      const id = `file${w.files.size + w.deleted.length + 1}`;
      w.files.set(id, { id, ...q.$, createdBy: 'site' });
      return json({ createFile: { createdFile: { id } } });
    }
    case 'updateFile': {
      const f = w.files.get(q.$.id);
      if (!f) return new Response('no such file', { status: 404 });
      Object.assign(f, q.$);
      return json({});
    }
    case 'deleteFile': {
      w.files.delete(q.$.id);
      w.deleted.push(q.$.id);
      return json({});
    }
    case 'file': {
      const f = w.files.get(q.$.id);
      return json({ file: f ? fileNode(f) : null });
    }
    case 'job': {
      const names = [].concat(q.files?.$?.where?.[2] ?? []);
      const files = [...w.files.values()].filter((f) => f.targetType === 'job' && f.targetId === q.$.id && names.includes(f.name));
      const job = w.jobs.get(q.$.id);
      return json({ job: job ? { id: job.id, companycamId: job.companycamId || null, files: { nodes: files.map(fileNode) } } : null });
    }
    case 'updateJob': {
      const { id, ...changes } = q.$;
      // JobTread links a CompanyCam project to one job at most
      const holder = changes.companycamId && [...w.jobs.values()].find((j) => j.id !== id && j.companycamId === changes.companycamId);
      if (holder) return new Response(`This CompanyCam project is already linked to ${holder.name}. If you want to link it to this job, unlink it there first.`, { status: 400 });
      Object.assign(w.jobs.get(id), changes);
      return json({});
    }
    case 'createJob': {
      const id = `jobT${w.jobs.size + 1}`;
      const accountId = [...w.accounts.values()].find((a) => `loc-${a.id}` === q.$.locationId)?.id;
      let companycamId = q.$.companycamId || null;
      if (!companycamId) {
        // JobTread's own integration: a job made without a project gets an empty one of its own
        companycamId = String(++w.cc.next);
        w.cc.projects.set(companycamId, { id: companycamId, name: `Job ${companycamId}`, status: 'active', archived: false, address: { street_address_1: 'elsewhere' }, created_at: new Date(w.now).toISOString(), project_url: `https://app.companycam.com/projects/${companycamId}` });
      }
      w.jobs.set(id, { id, accountId, name: q.$.name, companycamId, createdAt: new Date(w.now).toISOString() });
      return json({ createJob: { createdJob: { id, name: q.$.name } } });
    }
    default: throw new Error(`unexpected JobTread call: ${op}`);
  }
}

// ─── Fake CompanyCam ────────────────────────────────────────────────

const page = (data) => json({ data, errors: [], meta: { has_next: false, next_cursor: null } });
const one = (data, status = 200) => json({ data, errors: [], meta: {} }, status);
const notFound = () => json({ data: {}, errors: [{ code: 'not_found', message: 'Not found' }], meta: {} }, 404);
function projectOut(p) {
  return { ...p, photo_count: [...w.cc.photos.values()].filter((x) => x.project_id === p.id).length, document_count: [...w.cc.documents.values()].filter((x) => x.project_id === p.id).length };
}
async function companycam(url, init) {
  if (w.fail.ccToken || !['Bearer cc-token', 'Bearer cc-token-2'].includes(init.headers?.Authorization)) return json({ data: {}, errors: [{ code: 'invalid_token', message: 'Missing or invalid access token' }], meta: {} }, 401);
  const method = init.method || 'GET';
  const path = url.pathname.replace('/public_api/v1', '');
  const body = init.body ? JSON.parse(init.body) : null;
  w.ccCalls.push({ method, path, body });
  let m;
  if (method === 'GET' && path === '/projects/search') {
    const q = streetKey(url.searchParams.get('query'));
    return page([...w.cc.projects.values()].filter((p) => streetKey(p.address.street_address_1).includes(q.split(' ')[0])).map(projectOut));
  }
  if (method === 'POST' && path === '/projects') {
    const p = body.project;
    // CompanyCam's own rule: the same name at the same address is the project it already has
    const same = [...w.cc.projects.values()].find((x) => x.name === p.name && streetKey(x.address?.street_address_1) === streetKey(p.street_address_1));
    if (same) return one(projectOut(same), 200); // as it is, archived or not
    const id = ccId();
    const proj = { id, name: p.name, status: 'active', archived: false, address: { street_address_1: p.street_address_1, city: p.city, state: p.state, postal_code: p.postal_code, country: p.country }, coordinates: p.coordinates, primary_contact: p.primary_contact || null, description: null, created_at: new Date(w.now).toISOString(), updated_at: new Date(w.now).toISOString(), project_url: `https://app.companycam.com/projects/${id}` };
    w.cc.projects.set(id, proj);
    return one(projectOut(proj), 201);
  }
  if ((m = path.match(/^\/projects\/(\d+)$/)) && method === 'GET') return w.cc.projects.has(m[1]) ? one(projectOut(w.cc.projects.get(m[1]))) : notFound();
  if ((m = path.match(/^\/projects\/(\d+)\/(archive|unarchive)$/))) {
    const p = w.cc.projects.get(m[1]);
    if (!p) return notFound();
    p.archived = m[2] === 'archive';
    return one(projectOut(p));
  }
  if ((m = path.match(/^\/projects\/(\d+)\/description$/))) { w.cc.projects.get(m[1]).description = body.description; return one(projectOut(w.cc.projects.get(m[1]))); }
  if ((m = path.match(/^\/projects\/(\d+)\/labels$/)) && method === 'GET') return page(w.cc.labels.get(m[1]) || []);
  if ((m = path.match(/^\/projects\/(\d+)\/labels$/)) && method === 'POST') {
    const labels = body.project.labels.map((v) => ({ id: `label-${v}`, display_value: v, value: v.toLowerCase() }));
    w.cc.labels.set(m[1], [...(w.cc.labels.get(m[1]) || []), ...labels]);
    return one(labels, 201);
  }
  if ((m = path.match(/^\/projects\/(\d+)\/labels\/(.+)$/)) && method === 'DELETE') {
    w.cc.labels.set(m[1], (w.cc.labels.get(m[1]) || []).filter((l) => l.id !== decodeURIComponent(m[2])));
    return new Response(null, { status: 204 });
  }
  if ((m = path.match(/^\/projects\/(\d+)\/photos$/)) && method === 'GET') {
    if (!w.cc.projects.has(m[1])) return notFound();
    return page([...w.cc.photos.values()].filter((p) => p.project_id === m[1]).reverse());
  }
  if ((m = path.match(/^\/projects\/(\d+)\/photos$/)) && method === 'POST') {
    const up = w.cc.uploads.get(body.photo.upload_id);
    assert.ok(up?.put, 'the bytes went up before the photo was made');
    return one(addPhoto(m[1], { caption: body.photo.description }), 201);
  }
  if ((m = path.match(/^\/projects\/(\d+)\/documents$/)) && method === 'GET') {
    if (!w.cc.projects.has(m[1])) return notFound();
    return page([...w.cc.documents.values()].filter((d) => d.project_id === m[1]));
  }
  if ((m = path.match(/^\/photos\/(\d+)\/descriptions$/)) && method === 'POST') {
    const p = w.cc.photos.get(m[1]);
    p.description = { id: `d${p.id}b`, html_content: body.description.content, plain_text_content: body.description.content };
    p.updated_at = new Date(w.now).toISOString();
    return one(p, 201);
  }
  if ((m = path.match(/^\/photos\/(\d+)\/tags$/)) && method === 'POST') {
    const p = w.cc.photos.get(m[1]);
    p.tags = [...p.tags, ...body.tags.map((t) => ({ id: `t-${t}`, display_value: t, value: t.toLowerCase() }))];
    p.updated_at = new Date(w.now).toISOString();
    return one(p.tags, 201);
  }
  if (method === 'GET' && path === '/tags') return page([{ id: 'cct1', display_value: 'Roof', value: 'roof' }, { id: 'cct2', display_value: 'Exterior', value: 'exterior' }]);
  if ((m = path.match(/^\/photos\/(\d+)$/)) && method === 'GET') return w.cc.photos.has(m[1]) ? one(w.cc.photos.get(m[1])) : notFound();
  if ((m = path.match(/^\/documents\/(\d+)$/)) && method === 'GET') return w.cc.documents.has(m[1]) ? one(w.cc.documents.get(m[1])) : notFound();
  if (method === 'POST' && path === '/uploads') {
    const id = `ccup${w.cc.uploads.size + 1}`;
    assert.match(body.upload.checksum, /^[A-Za-z0-9+/]{22}==$/, 'a base64 MD5');
    w.cc.uploads.set(id, { ...body.upload });
    return one({ upload_id: id, upload_url: `https://uploads.example.com/cc/${id}`, method: 'PUT', headers: { 'Content-Type': body.upload.content_type, 'Content-MD5': body.upload.checksum }, expires_in: 3600 }, 201);
  }
  if (path === '/webhooks' && method === 'GET') return page([...w.cc.webhooks.values()].map((h) => ({ ...h, token: null })));
  if (path === '/webhooks' && method === 'POST') {
    const id = ccId();
    w.cc.webhooks.set(id, { id, enabled: true, ...body.webhook });
    return one(w.cc.webhooks.get(id), 201);
  }
  if ((m = path.match(/^\/webhooks\/(\d+)\/deliveries$/)) && method === 'GET') return page(w.cc.deliveries || []);
  if ((m = path.match(/^\/webhooks\/(\d+)$/))) {
    if (method === 'DELETE') { w.cc.webhooks.delete(m[1]); return new Response(null, { status: 204 }); }
    const { enabled, ...rest } = body.webhook;
    Object.assign(w.cc.webhooks.get(m[1]), rest, enabled === undefined ? {} : { enabled: String(enabled) === 'true' });
    return one(w.cc.webhooks.get(m[1]));
  }
  throw new Error(`unexpected CompanyCam call: ${method} ${path}`);
}

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.href === 'https://api.jobtread.com/pave') return jobtread(JSON.parse(init.body));
  if (url.origin === new URL(CC_API).origin) return companycam(url, init);
  if (url.host === 'uploads.example.com') {
    const m = url.pathname.match(/^\/cc\/(.+)$/);
    if (m) w.cc.uploads.get(m[1]).put = true;
    return new Response(null, { status: 200 });
  }
  if (url.href === 'https://sunshineonaranneyday.com/og/home.png') return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), { status: 200, headers: { 'Content-Type': 'image/png' } });
  if (url.host === 'cdn.example.com') return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  if (url.host === 'slack.com') {
    const body = JSON.parse(init.body || '{}');
    if (url.pathname.endsWith('/chat.update')) { w.slackEdits.push(body); return json({ ok: true, channel: body.channel, ts: body.ts }); }
    if (url.pathname.endsWith('/chat.postMessage')) { w.slack.push(body); return json({ ok: true, channel: body.channel, ts: `${w.slack.length}.0001` }); }
    return json({ ok: true });
  }
  throw new Error(`unexpected fetch: ${url.href}`);
}

// ─── The world's people and things ──────────────────────────────────

const HOME = { street: '12 Example Crossing', city: 'Sampleton', state: 'GA', postal: '30000' };
async function family(id, name, status, { home = HOME, year = '2027', types = ['Bedroom'], appPhotos = true } = {}) {
  const a = { id, name, status, year, types, home, contact: { name: `${name.split(' ')[0]} Parent`, email: `${id}@example.com`, phone: '+15555550100' } };
  w.accounts.set(id, a);
  await mirror(a);
  if (appPhotos) {
    for (const k of ['photoChild', 'photoSpace1', 'photoSpace2']) w.files.set(`app-${id}-${k}`, { id: `app-${id}-${k}`, name: `${name} ${k}.jpg`, targetType: 'account', targetId: id, createdBy: 'form' });
    await env.DB.prepare('INSERT INTO applications (id, jt_account_id, jt_state) VALUES (?, ?, ?)').bind(`app-${id}`, id, JSON.stringify({ files: { photoChild: { id: `app-${id}-photoChild` }, photoSpace1: { id: `app-${id}-photoSpace1` }, photoSpace2: { id: `app-${id}-photoSpace2` } } })).run();
  }
  return a;
}
/** The applicant mirror, as ./_applicants.js keeps it */
async function mirror(a) {
  const job = [...w.jobs.values()].filter((j) => j.accountId === a.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
  await env.DB.prepare(`INSERT INTO applicants (account_id, name, status, year, archived_at, job_id, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET name = excluded.name, status = excluded.status, archived_at = excluded.archived_at, job_id = excluded.job_id`)
    .bind(a.id, a.name, a.status, a.year, a.archivedAt || null, job?.id || null, new Date(w.now).toISOString()).run();
}
async function setStatus(a, status) { a.status = status; await mirror(a); }
async function makeJob(a, { id = `job-${a.id}`, name = `${a.name} (${a.year})`, companycamId = null, createdAt = new Date(w.now).toISOString(), closedOn = null } = {}) {
  w.jobs.set(id, { id, accountId: a.id, name, companycamId, createdAt, closedOn });
  await mirror(a);
  return w.jobs.get(id);
}
function addPhoto(projectId, { caption = '', tags = [], at: when = w.now } = {}) {
  const id = ccId();
  const photo = {
    id, project_id: String(projectId), status: 'active', processing_status: 'processed', hash: `h${id}`,
    uris: [{ type: 'original', uri: `https://cdn.example.com/cc/${id}.jpg`, url: `https://cdn.example.com/cc/${id}.jpg` }, { type: 'web', uri: 'x', url: `https://cdn.example.com/cc/${id}-web.jpg` }],
    description: { id: `d${id}`, html_content: caption, plain_text_content: caption },
    tags: tags.map((t) => ({ id: `t-${t}`, display_value: t, value: t.toLowerCase() })),
    annotations: null, photo_url: `https://app.companycam.com/photos/${id}`,
    captured_at: new Date(when).toISOString(), created_at: new Date(when).toISOString(), updated_at: new Date(when).toISOString(),
  };
  w.cc.photos.set(id, photo);
  return photo;
}
/** JobTread's own integration: the linked project's photos, copied to the job as "CompanyCam <id>" */
function jobtreadImports(jobId) {
  const job = w.jobs.get(jobId);
  for (const p of w.cc.photos.values()) {
    if (p.project_id !== job.companycamId) continue;
    const name = `CompanyCam ${p.id}`;
    if ([...w.files.values()].some((f) => f.targetId === jobId && f.name === name)) continue;
    const id = `native${p.id}`;
    w.files.set(id, { id, name, targetType: 'job', targetId: jobId, folder: null, fileTagIds: [], createdBy: 'CompanyCam' });
  }
}

const run = (m, o = {}) => { w.now = at(m); return maybeRunCompanyCam(env, { fetchImpl: fakeFetch, now: at(m), force: true, ...o }); };
const familyProject = async (a) => (await getFamilyRow(env.DB, a.id))?.project_id;
const customerFiles = (a) => [...w.files.values()].filter((f) => f.targetType === 'account' && f.targetId === a.id && f.createdBy === 'site');
const jobFiles = (jobId) => [...w.files.values()].filter((f) => f.targetType === 'job' && f.targetId === jobId);
const activity = async (a) => (await env.DB.prepare('SELECT title FROM applicant_activity WHERE account_id = ? ORDER BY at').bind(a.id).all()).results.map((r) => r.title);

async function signed(body, { token, signature } = {}) {
  const raw = JSON.stringify(body);
  const sig = signature ?? await signatureFor(token ?? await webhookToken(env), raw);
  const pending = [];
  const res = await webhookPost({ env, request: new Request('https://sunshineonaranneyday.com/api/companycam-webhook', { method: 'POST', body: raw, headers: { 'X-CompanyCam-Signature': sig, 'Content-Type': 'application/json' } }), waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return res;
}
const photoCreated = (p) => ({ event_type: 'photo.created', created_at: Math.floor(w.now / 1000), webhook_id: 1, payload: { photo: { id: Number(p.id), project_id: Number(p.project_id), description: 'whatever the body says' } } });

beforeEach(async () => {
  w = newWorld();
  env = {
    DB: await createD1({ schemaFiles: ['scripts/schema.sql'], schemaSql: ['CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, jt_account_id TEXT, jt_state TEXT)'] }),
    JOBTREAD_GRANT_KEY: 'site-grant', COMPANYCAM_TOKEN: 'cc-token', COMPANYCAM_CUSTOMER_STAGE: 'on',
  };
  await ensureApplicantSchema(env.DB);
  // The one-time check has its own test (the last one); everywhere else it's done
  await ensureCompanyCamSchema(env.DB);
  await env.DB.prepare("INSERT INTO companycam_state (key, value, updated_at) VALUES ('self-test', ?, ?)").bind(JSON.stringify({ id: SELF_TEST, step: 'done' }), new Date(T0).toISOString()).run();
  realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch; // Slack, and the webhook route's own work, use the global fetch
});
afterEach(() => { globalThis.fetch = realFetch; });

// ─── The project ────────────────────────────────────────────────────

test('In Review: one project at their home, named for the job to come, with the family’s photos of the space', async () => {
  const a = await family('acct1', 'Avery Stone', 'In Review');
  await run(0);
  const row = await getFamilyRow(env.DB, a.id);
  assert.equal(row.stage, 'customer');
  assert.equal(row.how, 'made');
  const p = w.cc.projects.get(row.project_id);
  assert.equal(p.name, 'Avery Stone (2027)', 'the job’s name to come, so JobTread’s copy lines up');
  assert.deepEqual(p.address, { street_address_1: HOME.street, city: HOME.city, state: HOME.state, postal_code: HOME.postal, country: 'US' });
  assert.deepEqual(p.coordinates, { lat: '33.9', lon: '-84.4' });
  assert.equal(p.primary_contact.email, 'acct1@example.com');
  assert.match(p.description, /^Bedroom makeover \(2027\)\. .*https:\/\/app\.jobtread\.com\/customers\/acct1$/);
  assert.deepEqual((w.cc.labels.get(p.id) || []).map((l) => l.display_value), [VETTING_LABEL]);
  const photos = [...w.cc.photos.values()].filter((x) => x.project_id === p.id);
  assert.equal(photos.length, 2, 'the two space photos, not the child or family portraits');
  assert.ok(photos.every((x) => x.description.plain_text_content === 'Sent by the family with their application'));
  assert.equal(await familyProjectId(env.DB, a.id), p.id, 'what the approval hands createJob');
  assert.match((await activity(a))[0], /^CompanyCam project ready for the home visit: Avery Stone \(2027\)$/);

  // Their webhooks never copy them back to JobTread, where they came from
  for (const x of photos) assert.equal((await signed(photoCreated(x))).status, 200);
  assert.equal(customerFiles(a).length, 0);

  // Again: nothing new
  await run(2);
  assert.equal(w.cc.projects.size, 1);
  assert.equal([...w.cc.photos.values()].length, 2);
});

test('a project staff already started at the house is used, but never one an earlier job uses', async () => {
  const a = await family('acct2', 'Blake Rivers', 'In Review', { appPhotos: false });
  w.cc.projects.set('500', { id: '500', name: 'Rivers 2022', status: 'active', archived: false, address: { street_address_1: '12 Example Xing.' }, created_at: '2022-01-01T00:00:00Z', updated_at: '2022-05-01T00:00:00Z', project_url: 'https://app.companycam.com/projects/500' });
  await makeJob(a, { id: 'old-job', name: 'Blake Rivers (2022)', companycamId: '500', createdAt: '2022-01-01T00:00:00Z', closedOn: '2022-06-01' });
  w.cc.projects.set('501', { id: '501', name: 'Blake home visit', status: 'active', archived: false, address: { street_address_1: '12 example crossing' }, description: 'Started by staff', created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z', project_url: 'https://app.companycam.com/projects/501' });
  await run(0);
  const row = await getFamilyRow(env.DB, a.id);
  assert.equal(row.project_id, '501');
  assert.equal(row.how, 'adopted');
  assert.equal(w.cc.projects.get('501').description, 'Started by staff', 'staff’s own words stay');
  assert.ok(!w.ccCalls.some((c) => c.method === 'POST' && c.path === '/projects'));
  assert.equal(row.seen_job_id, null);
  await run(2);
  assert.equal((await getFamilyRow(env.DB, a.id)).stage, 'customer', 'the earlier makeover’s job isn’t this one');
});

test('no full home address: Slack hears once, and the project follows the address', async () => {
  env.SLACK_BOT_TOKEN = 'xoxb-test';
  await writeSlackConfig(env.DB, { channel: { id: 'C0NEWS', name: 'team' }, attention: { id: 'C0ALERT', name: 'alerts' } });
  const a = await family('acct3', 'Casey Lane', 'In Review', { home: null });
  await run(0);
  await run(3);
  await run(10);
  assert.equal((await getFamilyRow(env.DB, a.id)).stage, 'waiting');
  const problems = w.slack.filter((s) => /no CompanyCam project yet/.test(s.text || ''));
  assert.equal(problems.length, 1);
  assert.match(JSON.stringify(problems[0].blocks), /full home address/);
  a.home = HOME;
  await run(30);
  assert.equal((await getFamilyRow(env.DB, a.id)).stage, 'customer');
  assert.ok(w.slackEdits.some((e) => /Resolved/.test(JSON.stringify(e))), 'the problem turns ✅');
});

// ─── Photos ─────────────────────────────────────────────────────────

test('a home-visit photo copies to the customer once, from CompanyCam’s own record, in the folder with its tags', async () => {
  const a = await family('acct4', 'Drew Hart', 'In Review', { appPhotos: false });
  await run(0);
  const p = addPhoto(await familyProject(a), { caption: 'Hallway to the bedroom', tags: ['Exterior', 'Nope'] });
  assert.equal((await signed(photoCreated(p))).status, 200);
  const [copy] = customerFiles(a);
  assert.ok(copy, 'on the customer');
  assert.equal(copy.folder, FOLDER);
  assert.match(copy.name, /^Hallway to the bedroom · Oct 21, 2026, 11:00 AM\.jpg$/);
  assert.deepEqual(copy.fileTagIds, ['tagBefore', 'tagExterior'], '.BeforePics, and the CompanyCam tag JobTread also has');
  assert.match(copy.description, /^Hallway to the bedroom\nIn CompanyCam: https:\/\/app\.companycam\.com\/photos\//);
  assert.doesNotMatch(copy.description, /whatever the body says/, 'the webhook body is only a wake-up');

  // The same photo again (a retry, the heartbeat): still one copy
  await signed(photoCreated(p));
  await run(15);
  assert.equal(customerFiles(a).length, 1);
});

test('a caption, tag or markup added later follows; tags staff added in JobTread stay', async () => {
  const a = await family('acct5', 'Emery Fox', 'In Review', { appPhotos: false });
  await run(0);
  const p = addPhoto(await familyProject(a), { caption: 'Bath' });
  await signed(photoCreated(p));
  const [copy] = customerFiles(a);
  copy.fileTagIds = [...copy.fileTagIds, 'tagStaff'];
  p.description = { plain_text_content: 'Bath: tub too high' };
  p.tags = [{ display_value: 'Exterior' }];
  p.annotations = { text: ['Remove tub'], stickers: [], shapes: [] };
  p.hash = 'h-marked-up';
  p.updated_at = new Date(at(5)).toISOString();
  w.now = at(5);
  await signed({ event_type: 'photo.updated', payload: { photo: { id: Number(p.id), project_id: Number(p.project_id) } } });
  assert.match(copy.description, /^Bath: tub too high\nMarkup: Remove tub\n/);
  assert.deepEqual(copy.fileTagIds.sort(), ['tagBefore', 'tagExterior', 'tagStaff']);
  assert.ok(copy.annotatedUploadRequestId, 'the marked-up picture goes on as the file’s markup');
  assert.equal(customerFiles(a).length, 1);
});

test('the catch-up check copies what no webhook mentioned, and JobTread fetching a link it can’t open falls back to the bytes', async () => {
  const a = await family('acct6', 'Finley Moss', 'In Review', { appPhotos: false });
  await run(0);
  addPhoto(await familyProject(a), { caption: 'Missed one' });
  w.cc.documents.set('77', { id: '77', project_id: await familyProject(a), name: 'Measurements.pdf', url: 'https://cdn.example.com/cc/77.pdf' });
  w.fail.jtUrlFetch = true;
  await run(5);
  assert.equal(customerFiles(a).length, 0, 'not due yet');
  await run(11);
  await run(12);
  const names = customerFiles(a).map((f) => f.name).sort();
  assert.deepEqual(names, ['Measurements.pdf', 'Missed one · Oct 21, 2026, 11:00 AM.jpg']);
  assert.ok(w.jtCalls.some((c) => c.op === 'createUploadRequest' && c.args.size === 6), 'the site carried the bytes');
});

// ─── The job ────────────────────────────────────────────────────────

test('the job uses the home-visit project: JobTread copies the photos, and the customer’s copies move off', async () => {
  const a = await family('acct7', 'Gray Ellis', 'In Review', { appPhotos: false });
  await run(0);
  const project = await familyProject(a);
  const p1 = addPhoto(project, { caption: 'Door' });
  const p2 = addPhoto(project, { caption: 'Closet' });
  await signed(photoCreated(p1));
  await signed(photoCreated(p2));
  assert.equal(customerFiles(a).length, 2);
  customerFiles(a).find((f) => /Closet/.test(f.name)).comments = ['c1'];

  // Approved: the approval makes the job with the project's id (./_applicant-approved.js)
  await setStatus(a, 'Approved');
  const job = await makeJob(a, { companycamId: project });
  await run(2);
  const row = await getFamilyRow(env.DB, a.id);
  assert.equal(row.stage, 'linked');
  assert.equal(row.job_id, job.id);
  assert.deepEqual(w.cc.labels.get(project), [], 'no longer “Vetting”');
  assert.ok(!w.jtCalls.some((c) => c.op === 'updateJob'), 'already linked');
  assert.equal(await familyProjectId(env.DB, a.id), null);

  // A photo taken now is JobTread's to copy
  const p3 = addPhoto(project, { caption: 'After approval' });
  await signed(photoCreated(p3));
  assert.equal(customerFiles(a).length, 2);

  jobtreadImports(job.id);
  await run(5);
  assert.equal(customerFiles(a).length, 2, 'JobTread gets its turn first');
  await run(13);
  const left = customerFiles(a);
  assert.deepEqual(left.map((f) => f.name.split(' ')[0]), ['Closet'], 'one someone commented on stays');
  const native = jobFiles(job.id);
  assert.equal(native.length, 3, 'JobTread’s copies, nothing twice');
  assert.ok(native.filter((f) => f.name !== `CompanyCam ${p3.id}`).every((f) => f.folder === FOLDER && f.fileTagIds.includes('tagBefore')), 'the home-visit ones keep their folder and tag');
  assert.ok((await activity(a)).includes('Home visit photos are on the job'));
});

test('if JobTread never copies a photo, the site does it after 30 minutes', async () => {
  const a = await family('acct8', 'Harper Quinn', 'In Review', { appPhotos: false });
  await run(0);
  const p = addPhoto(await familyProject(a), { caption: 'Window' });
  await signed(photoCreated(p));
  const [ours] = customerFiles(a);
  const job = await makeJob(a, { companycamId: await familyProject(a) });
  await run(2);
  await run(20);
  assert.equal(jobFiles(job.id).length, 0);
  await run(33);
  const [copy] = jobFiles(job.id);
  assert.equal(copy.copyFromFileId, ours.id);
  assert.equal(copy.folder, FOLDER);
  assert.deepEqual(customerFiles(a), []);
});

test('a job made by hand with JobTread’s own empty project is switched to the home-visit one', async () => {
  const a = await family('acct9', 'Indy Park', 'In Review', { appPhotos: false });
  await run(0);
  w.cc.projects.set('800', { id: '800', name: 'Indy Park (2027) (040)', status: 'active', archived: false, address: { street_address_1: HOME.street }, project_url: 'https://app.companycam.com/projects/800' });
  const job = await makeJob(a, { companycamId: '800' });
  await run(2);
  assert.equal(w.jobs.get(job.id).companycamId, await familyProject(a));
  assert.equal(w.cc.projects.get('800').archived, true, 'the empty one is archived');
  assert.equal((await getFamilyRow(env.DB, a.id)).stage, 'linked');
});

test('a job whose own project already has photos keeps it; the home-visit photos follow it there', async () => {
  const a = await family('acct10', 'Jules Ward', 'In Review', { appPhotos: false });
  await run(0);
  const visit = addPhoto(await familyProject(a), { caption: 'Before' });
  await signed(photoCreated(visit));
  w.cc.projects.set('801', { id: '801', name: 'Jules build', status: 'active', archived: false, address: { street_address_1: HOME.street }, project_url: 'https://app.companycam.com/projects/801' });
  addPhoto('801', { caption: 'Framing' });
  const job = await makeJob(a, { companycamId: '801' });
  await run(2);
  assert.equal((await getFamilyRow(env.DB, a.id)).stage, 'separate');
  assert.equal(w.jobs.get(job.id).companycamId, '801');
  await run(3);
  assert.equal(jobFiles(job.id).length, 1, 'the home-visit photo, copied to the job right away');
  assert.deepEqual(customerFiles(a), []);
  const later = addPhoto(await familyProject(a), { caption: 'One more' });
  await signed(photoCreated(later));
  assert.equal(jobFiles(job.id).length, 2, 'new home-visit photos go to the job directly');
});

// ─── Denied, and back ───────────────────────────────────────────────

test('Denied archives the project; back in review restores it', async () => {
  const a = await family('acct11', 'Kai Brooks', 'In Review', { appPhotos: false });
  await run(0);
  const project = await familyProject(a);
  const p = addPhoto(project, { caption: 'Kept' });
  await signed(photoCreated(p));
  await setStatus(a, 'Denied');
  await run(2);
  assert.equal(w.cc.projects.get(project).archived, true);
  assert.equal((await getFamilyRow(env.DB, a.id)).stage, 'closed');
  assert.equal(customerFiles(a).length, 1, 'their photos stay in JobTread');
  await setStatus(a, 'In Review');
  await run(4);
  assert.equal(w.cc.projects.get(project).archived, false);
  assert.equal((await getFamilyRow(env.DB, a.id)).stage, 'customer');
  assert.equal(w.cc.projects.size, 1, 'the same project, not a new one');
});

// ─── The webhook and the key ────────────────────────────────────────

test('the webhook: kept in CompanyCam with the site’s token, and refused unsigned', async () => {
  await run(0);
  const hooks = [...w.cc.webhooks.values()];
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].url, WEBHOOK_URL);
  assert.deepEqual(hooks[0].scopes, WEBHOOK_SCOPES);
  assert.equal(hooks[0].token, await webhookToken(env));
  hooks[0].enabled = false; // CompanyCam turned it off after failures
  w.cc.deliveries = [{ id: 'd9', event: 'photo.created', resource_id: '5', success: false, response_status: 404, error_message: 'Not Found', created_at: new Date(at(60)).toISOString() }];
  await run(70);
  assert.equal(w.cc.webhooks.get(hooks[0].id).enabled, true);
  const st = JSON.parse(await env.DB.prepare("SELECT value FROM companycam_state WHERE key = 'webhook'").first('value'));
  assert.deepEqual([st.action, st.turnedBackOn, st.failing], ['turned back on', 1, 1]);
  assert.deepEqual(st.recent[0], { event: 'photo.created', status: 404, ok: false, at: new Date(at(60)).toISOString(), error: 'Not Found' }, 'what CompanyCam sent, and the answer');
  w.cc.deliveries = [];
  // A new CompanyCam key means a new signing token: the webhook is replaced
  const before = hooks[0].id;
  env.COMPANYCAM_TOKEN = 'cc-token-2';
  const a = await family('acct12', 'Lane Ortiz', 'In Review', { appPhotos: false });
  await run(140);
  const now = [...w.cc.webhooks.values()];
  assert.equal(now.length, 1);
  assert.notEqual(now[0].id, before);
  assert.equal(now[0].token, await webhookToken(env));
  assert.notEqual(now[0].token, hooks[0].token);
  const p = addPhoto(await familyProject(a), { caption: 'Signed' });
  assert.equal((await signed(photoCreated(p), { signature: 'bm9wZQ==' })).status, 401);
  assert.equal((await signed(photoCreated(p), { token: 'someone-else' })).status, 401);
  assert.equal(customerFiles(a).length, 0);
  const res = await signed(photoCreated(p));
  assert.deepEqual(await res.json(), { ok: true }, 'nothing echoed back');
  assert.equal(customerFiles(a).length, 1);
  delete env.COMPANYCAM_TOKEN;
  assert.equal((await signed(photoCreated(p), { token: 'x' })).status, 401, 'no key: closed');
});

test('events for a job’s project (JobTread’s to copy) and junk do nothing', async () => {
  assert.deepEqual(await takeEvent(env, { event_type: 'photo.created', payload: { photo: { id: 5, project_id: 6 } } }), { ignored: 'not a family project' });
  assert.deepEqual(await takeEvent(env, { event_type: 'invoice.paid', payload: {} }), { ignored: 'event' });
  assert.deepEqual(await takeEvent(env, { event_type: 'photo.created', payload: { photo: { id: '1; drop', project_id: 6 } } }), { ignored: 'no ids' });
  // CompanyCam's newer bodies: "event", string ids; and one without its project is looked up
  const a = await family('acct18', 'Rory Vale', 'In Review', { appPhotos: false });
  await run(0);
  const p = addPhoto(await familyProject(a), { caption: 'Looked up' });
  assert.ok((await takeEvent(env, { event: 'photo.created', payload: { photo: { id: p.id } } }, { fetchImpl: fakeFetch, now: at(1) })).ccId, 'found by asking CompanyCam');
  assert.ok((await takeEvent(env, { event: 'document.created', payload: { document: { id: '88', project_id: String(await familyProject(a)) } } }, { now: at(1) })).ccId);
});

test('CompanyCam turning the key down: Slack once a day, and ✅ when a new key works', async () => {
  env.SLACK_BOT_TOKEN = 'xoxb-test';
  await writeSlackConfig(env.DB, { channel: { id: 'C0NEWS', name: 'team' }, attention: { id: 'C0ALERT', name: 'alerts' } });
  w.fail.ccToken = true;
  await run(0);
  await run(61);
  await run(122);
  const posts = w.slack.filter((s) => /turned down the site’s key/.test(s.text || ''));
  assert.equal(posts.length, 1);
  assert.match(JSON.stringify(posts[0].blocks), /app\.companycam\.com\/access-keys/);
  w.fail.ccToken = false;
  await run(183);
  assert.ok(w.slackEdits.some((e) => /Resolved/.test(JSON.stringify(e))));
  assert.equal((await companycamFacts(env)).tokenBad, false);
});

test('no key set: nothing runs', async () => {
  delete env.COMPANYCAM_TOKEN;
  await family('acct13', 'Morgan Bell', 'In Review');
  assert.equal(await maybeRunCompanyCam(env, { fetchImpl: fakeFetch, now: T0, force: true }), null);
  assert.equal(w.ccCalls.length, 0);
  assert.deepEqual(await companycamFacts(env), { on: false });
});

// ─── The pieces ─────────────────────────────────────────────────────

test('streets match however they’re written', () => {
  assert.equal(streetKey('12 Example Crossing'), streetKey('12 example xing.'));
  assert.equal(streetKey('400 North Main Street, #2'), streetKey('400 N Main St 2'));
  assert.notEqual(streetKey('12 Example Crossing'), streetKey('14 Example Crossing'));
});

test('a copy’s name and tags', () => {
  assert.equal(copyOf('photo', { description: { plain_text_content: '' }, captured_at: '2026-10-21T18:05:00Z' }).name, 'Home visit · Oct 21, 2026, 2:05 PM.jpg');
  assert.equal(copyOf('photo', { description: { plain_text_content: 'a/b: c' }, captured_at: 1792000000 }).name.startsWith('a b: c · '), true, 'webhook seconds, and no slashes in a file name');
  assert.equal(captionWords('TEST: the website checking CompanyCam to JobTread. Safe to ignore.'), 'TEST: the website checking CompanyCam to JobTread', 'a whole first sentence when it fits');
  assert.equal(captionWords('A really long caption about the hallway leading into the bedroom and the doorway width'), 'A really long caption about the hallway leading into the…', 'else whole words');
  assert.equal(copyOf('document', { name: 'Plan.pdf', project_id: '9' }).name, 'Plan.pdf');
  const tags = new Map([['beforepics', 'B'], ['exterior', 'E']]);
  assert.deepEqual(tagIdsFor('photo', [{ display_value: 'EXTERIOR' }, { display_value: 'Exterior' }], tags), ['B', 'E']);
  assert.deepEqual(tagIdsFor('document', [], tags), [], 'documents aren’t before pictures');
});

test('a family moved on before the project was made gets none', async () => {
  const a = await family('acct14', 'Noel Hayes', 'In Review', { appPhotos: false });
  a.status = 'Approved'; // JobTread moved on; the mirror hasn't caught up
  const r = await syncFamily(env, a.id, { fetchImpl: fakeFetch, now: T0 });
  assert.deepEqual(r, { id: a.id, moved: 'Approved' });
  assert.equal(await getFamilyRow(env.DB, a.id), null);
  assert.equal(w.cc.projects.size, 0);
});

test('a photo still processing waits, and one JobTread keeps refusing reaches Slack once', async () => {
  env.SLACK_BOT_TOKEN = 'xoxb-test';
  await writeSlackConfig(env.DB, { channel: { id: 'C0NEWS', name: 'team' }, attention: { id: 'C0ALERT', name: 'alerts' } });
  const a = await family('acct15', 'Oak Rhodes', 'In Review', { appPhotos: false });
  await run(0);
  const p = addPhoto(await familyProject(a), { caption: 'Slow' });
  p.processing_status = 'processing';
  await signed(photoCreated(p));
  assert.equal(customerFiles(a).length, 0);
  p.processing_status = 'processed';
  p.uris = []; // nothing JobTread can take
  for (let m = 3; m < 2000; m += 30) await run(m);
  const posts = w.slack.filter((s) => /won’t copy to JobTread/.test(s.text || ''));
  assert.equal(posts.length, 1);
  p.uris = [{ type: 'original', url: `https://cdn.example.com/cc/${p.id}.jpg` }];
  await run(2400);
  assert.equal(customerFiles(a).length, 1, 'it keeps trying, and lands');
  assert.equal((await processFile(env, `photo:${p.id}`, { fetchImpl: fakeFetch, now: at(2401) })).busy, true, 'nothing owed');
});

test('the one-time check: copy, update, link and move, on test things at the office, then tidied', async () => {
  await env.DB.prepare("DELETE FROM companycam_state WHERE key = 'self-test'").run();
  const office = { id: OFFICE_ACCOUNT, name: 'Sunshine Office', status: null, year: null, types: [], home: { street: '1 Office Park', city: 'Sampleton', state: 'GA', postal: '30001' }, contact: null };
  w.accounts.set(office.id, office);
  await run(0);
  const project = [...w.cc.projects.values()].find((p) => p.name === `TEST CompanyCam check ${SELF_TEST}`);
  assert.ok(project, 'a TEST project at the office, its own name each run');
  const [photo] = [...w.cc.photos.values()].filter((p) => p.project_id === project.id);
  // 1. CompanyCam processes it, and its webhook comes
  w.now = at(0.5);
  await signed(photoCreated(photo));
  const copy = customerFiles(office)[0];
  assert.equal(copy.name, 'TEST: the website checking CompanyCam to JobTread · Oct 21, 2026, 11:00 AM.jpg');
  // 2. A caption and a tag the company already has, added in CompanyCam
  await run(1);
  assert.equal(photo.description.plain_text_content, 'TEST: a caption added later in CompanyCam');
  assert.deepEqual(photo.tags.map((t) => t.display_value), ['Exterior'], 'the CompanyCam tag JobTread also has (":Exterior"), never a new one');
  w.now = at(1.2);
  await signed({ event_type: 'photo.description_updated', payload: { photo: { id: photo.id, project_id: photo.project_id } } });
  assert.match(copy.description, /^TEST: a caption added later in CompanyCam\n/);
  assert.ok(copy.fileTagIds.includes('tagExterior') && copy.fileTagIds.includes('tagBefore'));
  // 3. The TEST job, made with the project's id
  await run(2);
  const job = [...w.jobs.values()].find((j) => j.name === 'TEST CompanyCam check');
  assert.equal(job.companycamId, project.id);
  jobtreadImports(job.id);
  await run(3);
  assert.equal((await companycamFacts(env)).selfTest.step, 'job', 'JobTread gets three minutes');
  // 4. The move
  await run(6);
  const facts = (await companycamFacts(env)).selfTest;
  assert.deepEqual([facts.step, facts.ok, facts.linkKept, facts.imported], ['done', true, true, true]);
  const [native] = jobFiles(job.id);
  assert.equal(native.folder, FOLDER);
  assert.ok(native.fileTagIds.includes('tagBefore'));
  assert.deepEqual(customerFiles(office), [], 'the customer’s copy moved off');
  assert.equal(w.jobs.get(job.id).closedOn, '2026-10-21', 'the TEST job is closed');
  assert.equal(project.archived, true);
  assert.equal(await getFamilyRow(env.DB, OFFICE_ACCOUNT), null);
  // Never again
  await run(10);
  assert.equal([...w.cc.projects.values()].filter((p) => p.name.startsWith('TEST CompanyCam check')).length, 1);
});

test('the one-time check without CompanyCam’s webhook: the 10-minute check carries it, and the result says so', async () => {
  await env.DB.prepare("DELETE FROM companycam_state WHERE key = 'self-test'").run();
  w.accounts.set(OFFICE_ACCOUNT, { id: OFFICE_ACCOUNT, name: 'Sunshine Office', home: { street: '1 Office Park', city: 'Sampleton', state: 'GA', postal: '30001' }, contact: null, types: [] });
  for (let m = 0; m <= 60; m += 1) {
    await run(m);
    const job = [...w.jobs.values()].find((j) => j.name === 'TEST CompanyCam check');
    if (job) jobtreadImports(job.id);
  }
  const st = JSON.parse(await env.DB.prepare("SELECT value FROM companycam_state WHERE key = 'self-test'").first('value'));
  assert.equal(st.step, 'done');
  assert.equal(st.ok, false, 'not proven without the webhook');
  assert.match(st.warn, /webhook didn’t bring the photo; the 10-minute check did/);
  assert.equal(st.copied.byWebhook, false);
  assert.equal(st.updated.via, 'catch-up');
  assert.equal(st.updated.caption, true, 'the caption still followed');
  assert.equal([...w.cc.projects.values()].find((p) => p.name.startsWith('TEST CompanyCam check')).archived, true);
  assert.deepEqual(customerFiles(w.accounts.get(OFFICE_ACCOUNT)), []);
});

test('in review with their makeover’s job already open (a status nobody moved on): no home-visit project', async () => {
  const a = await family('acct16', 'Pax Reed', 'In Review', { year: '2026' });
  await makeJob(a, { id: 'job-2026', createdAt: '2026-04-22T15:26:28Z' });
  w.cc.projects.set('600', { id: '600', name: 'Pax Reed (2026)', status: 'active', archived: false, address: { street_address_1: HOME.street }, created_at: '2026-04-08T12:00:00Z', updated_at: '2026-06-01T00:00:00Z', project_url: 'https://app.companycam.com/projects/600' });
  for (let i = 0; i < 3; i++) addPhoto('600', { caption: `Build ${i}` });
  await run(0);
  assert.equal((await getFamilyRow(env.DB, a.id)).stage, 'has-job');
  assert.equal(w.cc.projects.size, 1, 'nothing made');
  await run(30);
  await run(60);
  assert.equal(customerFiles(a).length, 0, 'their build photos stay JobTread’s to copy');
  assert.ok(!w.ccCalls.some((c) => c.path === '/projects/600/photos'), 'never even read');
});

test('a new makeover at a house with an earlier one: never the old project, even when CompanyCam hands it back by name', async () => {
  const a = await family('acct17', 'Quill Moss', 'In Review', { year: '2027', appPhotos: false });
  await makeJob(a, { id: 'job-2025', name: 'Quill Moss (2025)', createdAt: '2025-03-01T00:00:00Z', closedOn: '2025-09-01' });
  // Last time's project: the same name the new one would get, at the same address, linked to nothing any more
  w.cc.projects.set('700', { id: '700', name: 'Quill Moss (2027)', status: 'active', archived: true, address: { street_address_1: HOME.street }, created_at: '2025-02-20T00:00:00Z', updated_at: '2025-09-01T00:00:00Z', project_url: 'https://app.companycam.com/projects/700' });
  addPhoto('700', { caption: 'Old build' });
  await run(0);
  const row = await getFamilyRow(env.DB, a.id);
  assert.notEqual(row.project_id, '700');
  assert.equal(row.how, 'made');
  assert.equal(w.cc.projects.get(row.project_id).name, 'Quill Moss (2027) home visit');
  await run(15);
  assert.equal(customerFiles(a).length, 0, 'the old build photos never copy');
});

test('a newer check tidies an earlier one still under way before it starts', async () => {
  const office = { id: OFFICE_ACCOUNT, name: 'Sunshine Office', home: { street: '1 Office Park', city: 'Sampleton', state: 'GA', postal: '30001' }, contact: null, types: [] };
  w.accounts.set(office.id, office);
  w.cc.projects.set('950', { id: '950', name: 'TEST CompanyCam check', status: 'active', archived: false, address: { street_address_1: '1 Office Park' }, project_url: 'https://app.companycam.com/projects/950' });
  w.files.set('oldcopy', { id: 'oldcopy', name: 'old.jpg', targetType: 'account', targetId: OFFICE_ACCOUNT, createdBy: 'site' });
  w.jobs.set('oldjob', { id: 'oldjob', accountId: OFFICE_ACCOUNT, name: 'TEST CompanyCam check', companycamId: '950', createdAt: new Date(T0).toISOString() });
  await env.DB.prepare("UPDATE companycam_state SET value = ? WHERE key = 'self-test'").bind(JSON.stringify({ id: 'older', step: 'job', projectId: '950', copied: { fileId: 'oldcopy' }, jobId: 'oldjob', jobAt: new Date(T0).toISOString() })).run();
  // An interrupted run's copy, and a file that isn't a test's
  w.files.set('stray', { id: 'stray', name: 'TEST: x.jpg', folder: FOLDER, description: 'TEST: the website checking CompanyCam to JobTread. Safe to ignore.', targetType: 'account', targetId: OFFICE_ACCOUNT, createdBy: 'site' });
  w.files.set('real', { id: 'real', name: 'Office.jpg', folder: FOLDER, description: 'The office', targetType: 'account', targetId: OFFICE_ACCOUNT, createdBy: 'site' });
  await run(0);
  assert.equal(w.files.has('stray'), false, 'a test copy left behind goes');
  assert.equal(w.files.has('real'), true, 'anything else stays');
  assert.equal(w.cc.projects.get('950').archived, true);
  assert.equal(w.jobs.get('oldjob').closedOn, '2026-10-21');
  assert.equal(w.files.has('oldcopy'), false);
  await run(1);
  assert.ok([...w.cc.projects.values()].some((p) => p.name === `TEST CompanyCam check ${SELF_TEST}`), 'then the new one starts');
});

test('a project CompanyCam hands back archived (same name, this visit) is opened again before it’s used', async () => {
  const a = await family('acct19', 'Sam Ray', 'In Review', { appPhotos: false });
  w.cc.projects.set('980', { id: '980', name: 'Sam Ray (2027)', status: 'active', archived: true, address: { street_address_1: HOME.street }, created_at: new Date(at(-12 * 60)).toISOString(), updated_at: new Date(at(-60)).toISOString(), project_url: 'https://app.companycam.com/projects/980' });
  await run(0);
  const row = await getFamilyRow(env.DB, a.id);
  assert.equal(row.project_id, '980');
  assert.equal(w.cc.projects.get('980').archived, false, 'an archived project sends no webhooks');
});

test('the one-time check keeps what CompanyCam sent it, for reading the result', async () => {
  await env.DB.prepare("DELETE FROM companycam_state WHERE key = 'self-test'").run();
  w.accounts.set(OFFICE_ACCOUNT, { id: OFFICE_ACCOUNT, name: 'Sunshine Office', home: { street: '1 Office Park', city: 'Sampleton', state: 'GA', postal: '30001' }, contact: null, types: [] });
  w.cc.deliveries = [{ id: 'd1', event: 'photo.created', resource_id: '1', success: true, response_status: 200, created_at: new Date(T0).toISOString() }];
  for (let m = 0; m <= 60; m += 1) {
    await run(m);
    const job = [...w.jobs.values()].find((j) => j.name === 'TEST CompanyCam check');
    if (job) jobtreadImports(job.id);
  }
  const st = JSON.parse(await env.DB.prepare("SELECT value FROM companycam_state WHERE key = 'self-test'").first('value'));
  assert.equal(st.step, 'done');
  assert.deepEqual(st.deliveries, [{ event: 'photo.created', id: '1', ok: true, status: 200, at: new Date(T0).toISOString() }]);
});

test('caption and tag events find their photo wherever the body puts it; an unreadable one leaves its shape', async () => {
  const a = await family('acct20', 'Tate Lowe', 'In Review', { appPhotos: false });
  await run(0);
  const p = addPhoto(await familyProject(a), { caption: 'First' });
  await signed(photoCreated(p));
  const [copy] = customerFiles(a);
  p.description = { plain_text_content: 'Second' };
  p.updated_at = new Date(at(3)).toISOString();
  w.now = at(3);
  // The caption itself, with the photo as photo_id (and no project in sight)
  await signed({ event_type: 'photo.description_updated', created_at: 1, payload: { description: { id: 'd77', photo_id: p.id, content: 'Second' } } });
  assert.match(copy.description, /^Second\n/);
  await signed({ event_type: 'photo.tag_added', payload: { tag: { id: 't1', display_value: 'Roof' } } });
  const unread = JSON.parse(await env.DB.prepare("SELECT value FROM companycam_state WHERE key = 'webhook-unread'").first('value'));
  assert.deepEqual([unread.type, unread.keys], ['photo.tag_added', { tag: { id: 'string', display_value: 'string' } }], 'key names only, no values');
});

test('a photo CompanyCam marks as a duplicate of one already in the project isn’t copied twice', async () => {
  const a = await family('acct21', 'Uma Reyes', 'In Review', { appPhotos: false });
  await run(0);
  const p = addPhoto(await familyProject(a), { caption: 'Again' });
  p.processing_status = 'duplicate';
  await run(11); // the 10-minute check finds it
  await run(12); // and the next run looks at it
  assert.equal(customerFiles(a).length, 0);
  assert.equal((await env.DB.prepare('SELECT state FROM companycam_files WHERE cc_id = ?').bind(`photo:${p.id}`).first('state')), 'skipped');
});

test('the check’s picture: a real PNG, and a new one every run (CompanyCam ignores one already in the project)', async () => {
  const { inflateSync } = await import('node:zlib');
  const a = await testPicture(T0);
  const b = await testPicture(T0 + 60000);
  assert.deepEqual([...a.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(a.buffer, a.byteOffset);
  assert.deepEqual([v.getUint32(16), v.getUint32(20)], [480, 300]);
  const idatLen = v.getUint32(33);
  assert.equal(inflateSync(a.slice(41, 41 + idatLen)).length, 300 * (1 + 480 * 3), 'every row there');
  assert.notDeepEqual(a, b);
  assert.ok(a.length < 4000, 'small');
});

test('the rehearsal: two TEST families through the real stages, by the heartbeat, then archived', async () => {
  await env.DB.prepare("UPDATE companycam_state SET value = ? WHERE key = 'self-test'").bind(JSON.stringify({ id: SELF_TEST, step: 'done', ok: true })).run();
  w.accounts.set(OFFICE_ACCOUNT, { id: OFFICE_ACCOUNT, name: 'Sunshine Office', home: { street: '1 Office Park', city: 'Sampleton', state: 'GA', postal: '30001' }, contact: null, types: [] });
  const st = async () => JSON.parse(await env.DB.prepare("SELECT value FROM companycam_state WHERE key = 'rehearsal'").first('value'));
  await run(0);
  const a = [...w.accounts.values()].find((x) => x.name === 'TEST CompanyCam Family');
  const b = [...w.accounts.values()].find((x) => x.name === 'TEST CompanyCam Approved');
  assert.ok(a && b && a.status === 'In Review');
  await run(1);
  assert.equal((await st()).step, 'photo', 'both projects made by the heartbeat');
  const pa = w.cc.projects.get((await getFamilyRow(env.DB, a.id)).project_id);
  const pb = w.cc.projects.get((await getFamilyRow(env.DB, b.id)).project_id);
  assert.notEqual(pa.id, pb.id, 'two families at one address never share a project');
  const [photo] = [...w.cc.photos.values()].filter((x) => x.project_id === pa.id);
  w.now = at(1.5);
  await signed(photoCreated(photo));
  await run(2);
  assert.equal(a.status, 'Denied');
  await run(3);
  assert.equal(a.status, 'In Review', 'archived, then back in review');
  await run(4);
  assert.equal((await st()).step, 'jobs');
  await run(5);
  const jobA = [...w.jobs.values()].find((j) => j.accountId === a.id);
  jobtreadImports(jobA.id); // JobTread copies the project's photos once the job uses it
  await run(7);
  const r = await st();
  assert.equal(r.step, 'done');
  assert.equal(r.ok, true, JSON.stringify(r.checks) + (r.error || ''));
  assert.deepEqual(r.checks.jobs, { approvalLinked: true, byHandRelinked: true, theirsArchived: true, vettingLabelGone: true, importedAfterRelink: true });
  assert.ok(a.archivedAt && b.archivedAt, 'both TEST customers archived');
  assert.ok([...w.jobs.values()].filter((j) => j.accountId === a.id || j.accountId === b.id).every((j) => j.closedOn));
  assert.equal(await getFamilyRow(env.DB, a.id), null);
  assert.equal(pa.archived && pb.archived, true);
  await run(10);
  assert.equal([...w.accounts.values()].filter((x) => x.name.startsWith('TEST CompanyCam')).length, 2, 'once');
});

test('never a project another customer’s job uses at the same address, nor one from before the family applied', async () => {
  const a = await family('acct22', 'Vale Shaw', 'In Review', { appPhotos: false });
  // A job on someone else's account at this address, with its project, made after this family applied
  w.accounts.set('other', { id: 'other', name: 'Old Owner', home: HOME, contact: null, types: [] });
  w.cc.projects.set('990', { id: '990', name: 'Old Owner (2026)', status: 'active', archived: false, address: { street_address_1: HOME.street }, created_at: new Date(at(-60)).toISOString(), updated_at: new Date(at(-60)).toISOString(), project_url: 'https://app.companycam.com/projects/990' });
  w.jobs.set('otherjob', { id: 'otherjob', accountId: 'other', name: 'Old Owner (2026)', companycamId: '990', createdAt: new Date(at(-60)).toISOString() });
  // And a project nobody's job uses, but started before this family was a customer
  w.cc.projects.set('991', { id: '991', name: 'Something old', status: 'active', archived: false, address: { street_address_1: HOME.street }, created_at: new Date(at(-5 * 24 * 60)).toISOString(), updated_at: new Date(at(-5 * 24 * 60)).toISOString(), project_url: 'https://app.companycam.com/projects/991' });
  await run(0);
  const row = await getFamilyRow(env.DB, a.id);
  assert.ok(!['990', '991'].includes(row.project_id), `made its own (${row.project_id})`);
  assert.equal(row.how, 'made');
});

test('a project JobTread won’t link (already another job’s): the job keeps its own, and the home-visit photos follow it', async () => {
  const a = await family('acct23', 'Wren Hale', 'In Review', { appPhotos: false });
  await run(0);
  const project = await familyProject(a);
  const p = addPhoto(project, { caption: 'Before' });
  await signed(photoCreated(p));
  // Someone linked the home-visit project to another job by hand
  w.jobs.set('elsewhere', { id: 'elsewhere', accountId: 'someone', name: 'Another job', companycamId: project, createdAt: new Date(at(-1)).toISOString() });
  w.cc.projects.set('801', { id: '801', name: 'Wren Hale (2027) (050)', status: 'active', archived: false, address: { street_address_1: HOME.street }, project_url: 'https://app.companycam.com/projects/801' });
  const job = await makeJob(a, { companycamId: '801' });
  await run(2);
  const row = await getFamilyRow(env.DB, a.id);
  assert.equal(row.stage, 'separate', 'not stuck retrying a link JobTread refuses');
  assert.equal(w.jobs.get(job.id).companycamId, '801');
  await run(3);
  assert.equal(jobFiles(job.id).length, 1, 'the home-visit photo is on the job');
});

test('two families at one address whose names look alike still get a project each', async () => {
  const a = await family('acct24', 'Remi Powell', 'In Review', { appPhotos: false });
  const b = await family('acct25', 'Remi Powell', 'In Review', { appPhotos: false }); // same name, a second account
  await run(0);
  const pa = (await getFamilyRow(env.DB, a.id)).project_id;
  const pb = (await getFamilyRow(env.DB, b.id)).project_id;
  assert.ok(pa && pb && pa !== pb, `${pa} / ${pb}`);
  assert.equal(w.cc.projects.get(pb).name, 'Remi Powell (2027) home visit');
});

test('the project carries the family’s full name, not the job’s 30-character cut', async () => {
  const a = await family('acct26', 'Oakley Faye Xiu Ping Roberson', 'In Review', { appPhotos: false });
  await run(0);
  assert.equal(w.cc.projects.get((await getFamilyRow(env.DB, a.id)).project_id).name, 'Oakley Faye Xiu Ping Roberson (2027)');
});

test('off unless COMPANYCAM_CUSTOMER_STAGE is on: a family in review gets no project', async () => {
  delete env.COMPANYCAM_CUSTOMER_STAGE;
  const a = await family('acct27', 'Xan Ford', 'In Review', { appPhotos: false });
  await run(0);
  await run(3);
  assert.equal(await getFamilyRow(env.DB, a.id), null);
  assert.equal([...w.cc.projects.values()].length, 0);
  assert.equal(w.cc.webhooks.size, 1, 'the webhook and the rest stay');
});
