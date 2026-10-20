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
  const renderContact = (c, sel) => c && ({ id: c.id, name: c.name, customFieldValues: values(c.fields, sel?.customFieldValues?.$?.where) });
  const renderAccount = (a, sel) => {
    if (!a) return null;
    const commentWhere = sel.comments?.$?.where;
    const comments = a.comments.filter(c => !commentWhere || (commentWhere[1] === 'in' ? commentWhere[2].includes(c.name) : c.name === commentWhere[2]));
    return {
      id: a.id, name: a.name, type: a.type, createdAt: a.createdAt, organization: { id: a.org },
      customFieldValues: values(a.fields, sel.customFieldValues?.$?.where),
      primaryContact: renderContact(a.contacts.find(c => c.id === a.primaryContactId), sel.primaryContact),
      contacts: { nodes: a.contacts.map(c => renderContact(c, sel.contacts?.nodes)) },
      comments: { nodes: comments.map(c => ({ id: c.id, name: c.name, message: c.message })) },
    };
  };

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
          a.comments.push({ id, name: input.name ?? null, message: input.message, assignees: input.assignees || [], files: input.files || [], grantKey: $?.grantKey, internal: !input.assignees?.length });
          out.createComment = { createdComment: { id } };
          break;
        }
        case 'account':
          out.account = renderAccount(world.accounts[input.id], v);
          break;
        case 'organization': {
          const sel = v.accounts;
          const since = sel?.$?.where?.and?.find(w => w[0] === 'createdAt')?.[2];
          const nodes = Object.values(world.accounts)
            .filter(a => a.type === 'customer' && (!since || a.createdAt >= since))
            .map(a => ({ id: a.id, customFieldValues: values(a.fields, sel?.nodes?.customFieldValues?.$?.where) }));
          out.organization = { accounts: { nodes } };
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
    if (url.host === 'challenges.cloudflare.com') return json({ success: world.turnstile });
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
