/**
 * Everything the application pipeline talks to, faked in memory for tests:
 * JobTread (accounts, contacts, locations, upload requests, files, comments),
 * JobTread's upload URLs, Cloudflare Stream, Resend (one-off email), the
 * Slack webhook, Turnstile, R2 and Workers AI. One `fetchImpl` routes by
 * URL; `world` holds the state.
 *
 *   const w = fakeApplicantWorld();
 *   env = { ...w.env, DB }    // FILES, AI, keys
 *   processApplication(env, id, { fetchImpl: w.fetchImpl })
 *
 * The admin's Applicants view (functions/api/_applicants.js) reads accounts
 * with their contacts, home (latitude/longitude), jobs and files, writes with
 * updateAccount, and reads JobTread's event log: world.events, newest last,
 * which updateAccount and createComment append to like JobTread does.
 *
 * Failure knobs: w.failNext.set('createContact', 1) fails the next call with
 * a 500; w.loseNext.add('createAccount') performs the create, then throws as
 * if the response never arrived. world.emailDown / world.slackDown make
 * every Resend / Slack call fail until set back to false.
 */

export const ORG = '22NJw42j5GLg';

export function fakeApplicantWorld() {
  let seq = 0;
  const nextId = (p) => `${p}${String(++seq).padStart(8, '0')}`;
  const world = {
    accounts: {}, uploadRequests: {}, puts: [], emails: [], slack: [], calls: [],
    emailDown: false, slackDown: false,
    videos: {}, downloads: {}, deletedVideos: [], streamMeta: {},
    turnstile: true,
    events: [],
  };
  const failNext = new Map();
  const loseNext = new Set();

  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  const values = (fields, where) => {
    const ids = where ? (where[1] === 'in' ? where[2] : [where[2]]) : Object.keys(fields);
    const nodes = [];
    for (const id of ids) {
      const v = fields[id];
      if (v == null) continue;
      for (const one of Array.isArray(v) ? v : [v]) nodes.push({ value: one, customField: { id } });
    }
    return { nodes };
  };
  const renderContact = (c, sel) => c && ({ id: c.id, name: c.name, title: c.title || null, customFieldValues: values(c.fields, sel?.customFieldValues?.$?.where) });
  const nameMatch = (w, name) => !w || (w[1] === 'in' ? w[2].includes(name) : name === w[2]);
  // Only what the query selects, like JobTread (aliases via "_")
  const renderAccount = (a, sel) => {
    if (!a) return null;
    const out = {};
    for (const [key, sub] of Object.entries(sel || {})) {
      if (key === '$') continue;
      switch (sub?._ || key) {
        case 'id': case 'name': case 'type': case 'createdAt': out[key] = a[sub?._ || key]; break;
        case 'archivedAt': out[key] = a.archivedAt || null; break;
        case 'organization': out[key] = { id: a.org }; break;
        case 'customFieldValues': out[key] = values(a.fields, sub.$?.where); break;
        case 'primaryContact': out[key] = renderContact(a.contacts.find(c => c.id === a.primaryContactId), sub); break;
        case 'contacts': out[key] = { nodes: a.contacts.map(c => renderContact(c, sub.nodes)) }; break;
        case 'primaryLocation': {
          const l = a.locations[0];
          out[key] = l ? { id: l.id, address: l.address || null, city: l.city || null, county: l.county || null, latitude: l.latitude ?? null, longitude: l.longitude ?? null, customFieldValues: values(l.customFieldValues || {}, sub.customFieldValues?.$?.where) } : null;
          break;
        }
        case 'jobs': out[key] = { nodes: (a.jobs || []).map(j => ({ id: j.id, name: j.name })) }; break;
        case 'comments': {
          const list = a.comments.filter(c => nameMatch(sub.$?.where, c.name));
          out[key] = { nodes: list.map(c => ({
            id: c.id, name: c.name, message: c.message, createdAt: c.createdAt || null, isFromEmail: !!c.fromEmail, isPinned: !!c.pinned,
            isVisibleToCustomerRoles: false, createdByUser: { id: 'u1', name: c.by || 'Qualification Committee' },
            parentComment: c.parentCommentId ? { id: c.parentCommentId } : null, files: { nodes: [] },
          })) };
          break;
        }
        case 'files': out[key] = { nodes: a.files.map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size, createdAt: f.createdAt || null, url: `https://cdn.fake/${f.id}`, thumb: null, job: null })) }; break;
        default: break;
      }
    }
    return out;
  };
  // Pave "where": [field, op, value] or { and: [...] }
  const FIELD_NAMES = { '22P46wDp3NLd': 'Status', '22P46st8HNPY': 'Diagnosis', '22P52xmCz3cx': '*Makeover Year', '22P5KVgrLeXK': '*Makeover Type', '22PJx2jt4Vma': 'Denial Reason', '22P4VnkCXPSY': 'Gender' };
  const test = (row, w) => {
    if (!w) return true;
    if (w.and) return w.and.every(x => test(row, x));
    const [f, op, val] = w;
    const v = row[Array.isArray(f) ? f.join('.') : f];
    if (op === '=') return v === val;
    if (op === 'in') return val.includes(v);
    if (op === '>') return v > val;
    if (op === '>=') return v >= val;
    if (op === '<') return v < val;
    if (op === '<=') return v <= val;
    return true;
  };
  const pageOf = (list, $) => {
    const start = Number($?.page || 0);
    const size = $?.size || 100;
    const nodes = list.slice(start, start + size);
    return { nodes, nextPage: start + size < list.length ? String(start + size) : null };
  };
  const logEvent = (type, a, data, by = 'Site') => world.events.push({
    id: nextId('evt'), createdAt: new Date(Date.now() + world.events.length).toISOString(), type,
    createdByGrantId: '22PgGhFHkmbz', createdByGrantName: 'soard-site-CF', createdByUser: { id: 'u1', name: by }, data,
    account: { id: a.id, type: a.type },
  });

  function pave(query) {
    const { $, ...rest } = query;
    const out = {};
    for (const [key, v] of Object.entries(rest)) {
      world.calls.push({ op: key, input: v.$, grantKey: $?.grantKey });
      const fails = failNext.get(key);
      if (fails) { failNext.set(key, fails - 1); throw Object.assign(new Error(`${key} failed`), { status: 500 }); }
      const input = v.$ || {};
      switch (key) {
        case 'createAccount': {
          const id = nextId('acct');
          let name = input.name;
          if (input.suffixIfNecessary) {
            let n = 2;
            while (Object.values(world.accounts).some(a => a.name === name)) name = `${input.name} ${n++}`;
          }
          world.accounts[id] = { id, name, type: input.type, org: input.organizationId, createdAt: new Date().toISOString(), fields: { ...(input.customFieldValues || {}) }, contacts: [], primaryContactId: null, locations: [], files: [], comments: [] };
          out.createAccount = { createdAccount: { id } };
          break;
        }
        case 'createContact': {
          const a = world.accounts[input.accountId];
          if (!a) throw Object.assign(new Error('no account'), { status: 400 });
          const id = nextId('ctc');
          a.contacts.push({ id, name: input.name, title: input.title, fields: { ...(input.customFieldValues || {}) } });
          a.primaryContactId ||= id;
          out.createContact = { createdContact: { id } };
          break;
        }
        case 'createLocation': {
          const a = world.accounts[input.accountId];
          const id = nextId('loc');
          a.locations.push({ id, ...input });
          out.createLocation = { createdLocation: { id } };
          break;
        }
        case 'createUploadRequest': {
          const id = nextId('upl');
          world.uploadRequests[id] = { id, size: input.size, type: input.type, fromUrl: input.url || null, uploaded: !!input.url, used: false };
          out.createUploadRequest = { createdUploadRequest: { id, url: `https://uploads.fake/${id}`, method: 'PUT', headers: { 'x-fake-upload': id } } };
          break;
        }
        case 'createFile': {
          const a = world.accounts[input.targetId];
          const req = world.uploadRequests[input.uploadRequestId];
          if (!a || !req?.uploaded || req.used) throw Object.assign(new Error('bad upload request'), { status: 400 });
          req.used = true;
          const id = nextId('file');
          a.files.push({ id, name: input.name, type: req.type, fromUrl: req.fromUrl, size: req.size });
          out.createFile = { createdFile: { id } };
          break;
        }
        case 'createComment': {
          const a = world.accounts[input.targetId];
          if (!a) throw Object.assign(new Error('no account'), { status: 400 });
          for (const f of input.files || []) {
            const req = world.uploadRequests[f.uploadRequestId];
            if (!req?.uploaded || req.used) throw Object.assign(new Error('bad comment attachment'), { status: 400 });
            req.used = true;
          }
          const id = nextId('cmt');
          a.comments.push({ id, name: input.name ?? null, message: input.message, assignees: input.assignees || [], files: input.files || [], grantKey: $?.grantKey, internal: !input.assignees?.length, parentCommentId: input.parentCommentId || null, createdAt: new Date().toISOString() });
          logEvent('commentCreated', a, { next: { id, name: input.name ?? null, message: input.message, targetType: 'account', jobId: null, parentCommentId: input.parentCommentId || null }, previous: null });
          out.createComment = { createdComment: { id } };
          break;
        }
        case 'updateAccount': {
          // Like JobTread: updateAccount returns the query root, so selecting
          // "account" under it is a new lookup that needs its own id
          if (v.account && !v.account.$) throw Object.assign(new Error('A non-null value is required at "updateAccount"."account"."$"'), { status: 400 });
          const a = world.accounts[input.id];
          if (!a) throw Object.assign(new Error('no account'), { status: 400 });
          if ('archive' in input) {
            const was = a.archivedAt || null;
            a.archivedAt = input.archive ? new Date().toISOString() : null;
            logEvent('accountUpdated', a, { next: { archivedAt: a.archivedAt }, previous: { archivedAt: was } });
          }
          if (input.customFieldValues) {
            const next = {};
            const previous = {};
            for (const [fid, val] of Object.entries(input.customFieldValues)) {
              const name = FIELD_NAMES[fid] || fid;
              previous[name] = a.fields[fid] ?? null;
              next[name] = val;
              if (val == null) delete a.fields[fid];
              else a.fields[fid] = val;
            }
            logEvent('accountUpdated', a, { next: { custom: next }, previous: { custom: previous } });
          }
          out.updateAccount = {};
          break;
        }
        case 'account':
          out.account = renderAccount(world.accounts[input.id], v);
          break;
        case 'event': {
          const e = world.events.find(x => x.id === input.id);
          out.event = e ? { ...e, account: e.account ? { id: e.account.id, type: e.account.type } : null } : null;
          break;
        }
        case 'organization': {
          out.organization = {};
          if (v.accounts) {
            const sel = v.accounts;
            const list = Object.values(world.accounts)
              .filter(a => test({ id: a.id, type: a.type, name: a.name, createdAt: a.createdAt }, sel.$?.where))
              .sort((x, y) => (y.createdAt > x.createdAt ? 1 : -1));
            const { nodes, nextPage } = pageOf(list, sel.$);
            out.organization.accounts = { nodes: nodes.map(a => renderAccount(a, sel.nodes)), nextPage };
          }
          if (v.events) {
            const sel = v.events;
            const order = sel.$?.sortBy?.[0]?.order === 'desc' ? -1 : 1;
            const list = world.events.filter(e => test({ createdAt: e.createdAt, type: e.type }, sel.$?.where))
              .sort((x, y) => (x.createdAt > y.createdAt ? order : -order));
            out.organization.events = pageOf(list, sel.$);
          }
          break;
        }
        default:
          throw new Error(`fake JobTread doesn't know ${key}`);
      }
      if (loseNext.has(key)) { loseNext.delete(key); throw new Error(`${key}: network lost the response`); }
    }
    return out;
  }

  function stream(url, init) {
    const path = url.pathname.replace(/^\/client\/v4\/accounts\/[^/]+\/stream/, '');
    const method = (init?.method || 'GET').toUpperCase();
    if (path === '' && url.searchParams.get('direct_user') === 'true') {
      const uid = `vid${String(++seq).padStart(29, '0')}`;
      world.videos[uid] = { uid, readyToStream: false, status: { state: 'pendingupload' }, duration: -1, meta: init.headers['Upload-Metadata'] };
      return new Response(null, { status: 201, headers: { location: `https://upload.fake/tus/${uid}`, 'stream-media-id': uid } });
    }
    const m = path.match(/^\/([^/]+)(\/downloads|\/token)?$/);
    if (!m) return json({ success: false, errors: [{ message: 'not found' }] }, 404);
    const [, uid, sub] = m;
    const video = world.videos[uid];
    if (!video) return json({ success: false, errors: [{ message: 'video not found' }] }, 404);
    if (!sub && method === 'GET') return json({ success: true, result: video });
    if (!sub && method === 'DELETE') { world.deletedVideos.push(uid); delete world.videos[uid]; return json({ success: true, result: null }); }
    if (!sub && method === 'POST') { world.streamMeta[uid] = JSON.parse(init.body).meta; return json({ success: true, result: video }); }
    if (sub === '/downloads') {
      if (method === 'POST') world.downloads[uid] ||= { status: 'inprogress', url: `https://customer-x.cloudflarestream.com/${uid}/downloads/default.mp4` };
      return json({ success: true, result: world.downloads[uid] ? { default: world.downloads[uid] } : {} });
    }
    if (sub === '/token') return json({ success: true, result: { token: `signed-${uid}` } });
    return json({ success: false }, 400);
  }

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host === 'api.jobtread.com') {
      try {
        return json(pave(JSON.parse(init.body).query));
      } catch (e) {
        if (e.status) return new Response(e.message, { status: e.status });
        throw e;
      }
    }
    if (url.host === 'uploads.fake') {
      const id = url.pathname.slice(1);
      const req = world.uploadRequests[id];
      const body = init.body instanceof Uint8Array ? init.body : new Uint8Array(await new Response(init.body).arrayBuffer());
      world.puts.push({ id, size: body.byteLength, headers: init.headers });
      if (req) req.uploaded = true;
      return new Response('', { status: 200 });
    }
    if (url.host === 'api.cloudflare.com') return stream(url, init);
    if (url.host === 'api.resend.com') {
      if (world.emailDown) return json({ message: 'down' }, 500);
      const batch = JSON.parse(init.body);
      world.emails.push(...batch);
      return json({ data: batch.map((_, i) => ({ id: `em${i}` })) });
    }
    if (url.host === 'hooks.slack.test') {
      if (world.slackDown) return new Response('invalid_token', { status: 403 });
      world.slack.push(JSON.parse(init.body));
      return new Response('ok');
    }
    // The Slack app (when a test sets SLACK_BOT_TOKEN): posts land in world.slack too, edits in world.slackEdits
    if (url.host === 'slack.com') {
      if (world.slackDown) return json({ ok: false, error: 'invalid_auth' });
      const body = JSON.parse(init.body || '{}');
      if (url.pathname.endsWith('/chat.update')) { (world.slackEdits ||= []).push(body); return json({ ok: true, channel: body.channel, ts: body.ts }); }
      if (url.pathname.endsWith('/chat.postMessage')) { world.slack.push(body); return json({ ok: true, channel: body.channel, ts: `${world.slack.length}.0001` }); }
      return json({ ok: false, error: 'unknown_method' });
    }
    if (url.host === 'challenges.cloudflare.com') return json({ success: world.turnstile });
    // The Census geocoder: world.census maps a piece of an address to { lat, lng, county, matched };
    // anything else isn't found. world.censusDown answers 500. world.censusCalls counts the asks.
    if (url.host === 'geocoding.geo.census.gov') {
      world.censusCalls = (world.censusCalls || 0) + 1;
      if (world.censusDown) return new Response('down', { status: 500 });
      const q = String(url.searchParams.get('address') || '').toLowerCase();
      const m = Object.entries(world.census || {}).find(([k]) => q.includes(k.toLowerCase()))?.[1];
      return json({ result: { addressMatches: m ? [{ coordinates: { x: m.lng, y: m.lat }, matchedAddress: m.matched || q.toUpperCase(), geographies: { Counties: m.county ? [{ BASENAME: m.county }] : [] } }] : [] } });
    }
    throw new Error(`fake world has no route for ${url.href}`);
  };

  // R2
  const objects = new Map();
  const toBytes = async (body) => (body instanceof Uint8Array ? body : typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(await new Response(body).arrayBuffer()));
  const FILES = {
    objects,
    async put(key, body, opts = {}) { objects.set(key, { bytes: await toBytes(body), httpMetadata: opts.httpMetadata || {} }); },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return { httpMetadata: o.httpMetadata, size: o.bytes.byteLength, body: new Response(o.bytes).body, arrayBuffer: async () => o.bytes.slice().buffer };
    },
    async delete(key) { objects.delete(key); },
  };

  const AI = {
    prompts: [],
    available: true,
    async run(model, { messages }) {
      this.prompts.push(messages.at(-1).content);
      if (!this.available) throw new Error('AI unavailable');
      return { response: '{"summary": "A plain summary.", "description": "A longer description."}' };
    },
  };

  const env = {
    JOBTREAD_GRANT_KEY: 'site-grant', CF_ACCOUNT_ID: 'acct', CF_STREAM_TOKEN: 'stream-token', RESEND_API_KEY: 'resend', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/T0/B0/x', FILES, AI,
  };

  /** Make a video look fully uploaded / processed / downloadable */
  const advanceVideo = (uid, stage) => {
    const v = world.videos[uid];
    if (stage === 'uploaded') v.status = { state: 'inprogress' };
    if (stage === 'ready') { v.status = { state: 'ready' }; v.readyToStream = true; v.duration = 88; }
    if (stage === 'mp4') world.downloads[uid] = { ...(world.downloads[uid] || {}), status: 'ready', url: `https://customer-x.cloudflarestream.com/${uid}/downloads/default.mp4` };
  };

  return { world, fetchImpl, env, failNext, loseNext, advanceVideo, account: (id) => world.accounts[id] };
}
