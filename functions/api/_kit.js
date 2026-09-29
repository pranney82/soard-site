/**
 * Kit (formerly ConvertKit) v4 API helpers, shared by the newsletter
 * signup and broadcast endpoints.
 *
 * Auth is the account-level v4 API key (Kit → Settings → Developer →
 * API Keys), set as the KIT_API_KEY env var in the Cloudflare Pages
 * dashboard — never in the repo.
 *
 * Optional env vars:
 *   KIT_FORM_ID           — also add new subscribers to this Kit form so
 *                           its incentive/opt-in settings and automations
 *                           apply. Without it, subscribers are created
 *                           account-wide in the "active" state.
 *   KIT_EMAIL_TEMPLATE_ID — Kit template that wraps pushed broadcasts.
 *                           Account default template is used when unset;
 *                           our HTML is a full document, so a minimal
 *                           "HTML only" template in Kit renders cleanest.
 */

const KIT_API = 'https://api.kit.com/v4';

export function kitConfigured(env) {
  return Boolean(env.KIT_API_KEY);
}

function kitFetch(env, path, init = {}) {
  return fetch(`${KIT_API}${path}`, {
    ...init,
    headers: {
      'X-Kit-Api-Key': env.KIT_API_KEY,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

/**
 * Upsert a subscriber (201 created / 200 already existed), then add them
 * to KIT_FORM_ID if configured — the form add requires the subscriber to
 * already exist, hence the sequencing. Never throws.
 *
 * @param {{source?: string}} [opts] — where the signup came from; mapped to a
 *   Kit tag (see SOURCE_TAGS) so the team can email one audience at a time,
 *   e.g. only the families waiting for applications to reopen.
 * @returns {Promise<{configured: boolean, ok: boolean}>}
 */
export async function kitSubscribe(env, email, opts = {}) {
  if (!kitConfigured(env)) return { configured: false, ok: false };
  try {
    const res = await kitFetch(env, '/subscribers', {
      method: 'POST',
      body: JSON.stringify({ email_address: email, state: 'active' }),
    });
    if (!res.ok) {
      console.error(`Kit subscribe error ${res.status}: ${await res.text()}`);
      return { configured: true, ok: false };
    }

    if (env.KIT_FORM_ID) {
      const formRes = await kitFetch(env, `/forms/${env.KIT_FORM_ID}/subscribers`, {
        method: 'POST',
        body: JSON.stringify({ email_address: email }),
      });
      if (!formRes.ok) {
        // Subscriber exists in Kit even if the form add failed — still a
        // successful signup, just log so a bad KIT_FORM_ID gets noticed.
        console.error(`Kit add-to-form error ${formRes.status}: ${await formRes.text()}`);
      }
    }

    const tagName = tagForSource(opts.source);
    if (tagName) {
      // Best-effort: a tagging failure never fails the signup
      await kitTagSubscriber(env, email, tagName);
    }

    return { configured: true, ok: true };
  } catch (err) {
    console.error('Kit subscribe failed:', err);
    return { configured: true, ok: false };
  }
}

/* ── Source → tag ──
 * Form `source` values (validated by /api/newsletter) map to human-readable
 * Kit tags. Unknown-but-well-formed sources become Title Case tags so a new
 * form can start tagging without a code change. */
const SOURCE_TAGS = {
  'newsletter': 'Newsletter',
  'application-waitlist': 'Application Waitlist',
};
function tagForSource(source) {
  if (!source) return null;
  const key = String(source).toLowerCase();
  if (SOURCE_TAGS[key]) return SOURCE_TAGS[key];
  if (!/^[a-z0-9-]{2,40}$/.test(key)) return null;
  return key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const _tagIds = new Map(); // tag name → id, per isolate

/** Find a tag id by name, creating the tag on first use. Never throws. */
async function kitTagId(env, name) {
  if (_tagIds.has(name)) return _tagIds.get(name);
  try {
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const res = await kitFetch(env, `/tags?per_page=500${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
      if (!res.ok) { console.error(`Kit list tags error ${res.status}: ${await res.text()}`); break; }
      const data = await res.json();
      const hit = (data.tags || []).find(t => (t.name || '').toLowerCase() === name.toLowerCase());
      if (hit) { _tagIds.set(name, hit.id); return hit.id; }
      if (!data.pagination?.has_next_page) break;
      cursor = data.pagination.end_cursor;
    }
    const create = await kitFetch(env, '/tags', { method: 'POST', body: JSON.stringify({ name }) });
    const body = await create.json().catch(() => ({}));
    const id = body.tag?.id;
    if (!create.ok || !id) { console.error(`Kit create tag "${name}" error ${create.status}:`, JSON.stringify(body)); return null; }
    _tagIds.set(name, id);
    return id;
  } catch (err) {
    console.error('Kit tag lookup failed:', err);
    return null;
  }
}

/** Add a tag to an existing subscriber by email. Never throws. */
export async function kitTagSubscriber(env, email, tagName) {
  if (!kitConfigured(env)) return false;
  const tagId = await kitTagId(env, tagName);
  if (!tagId) return false;
  try {
    const res = await kitFetch(env, `/tags/${tagId}/subscribers`, {
      method: 'POST',
      body: JSON.stringify({ email_address: email }),
    });
    if (!res.ok) { console.error(`Kit tag subscriber error ${res.status}: ${await res.text()}`); return false; }
    return true;
  } catch (err) {
    console.error('Kit tag subscriber failed:', err);
    return false;
  }
}

/**
 * Create a DRAFT broadcast (send_at: null) — the admin reviews & sends
 * from the Kit dashboard. Kit drafts default to all active subscribers;
 * the audience is narrowed in Kit at send time.
 *
 * @returns {Promise<{ok: boolean, status?: number, broadcast?: object}>}
 */
export async function kitCreateBroadcast(env, { subject, previewText, description, html }) {
  const body = {
    subject,
    preview_text: previewText || '',
    description,
    content: html,
    public: false,
    send_at: null,
  };
  const templateId = parseInt(env.KIT_EMAIL_TEMPLATE_ID, 10);
  if (Number.isFinite(templateId)) body.email_template_id = templateId;

  const res = await kitFetch(env, '/broadcasts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Kit broadcast error ${res.status}:`, JSON.stringify(result));
    return { ok: false, status: res.status };
  }
  return { ok: true, broadcast: result.broadcast || result };
}

// Kit statuses → the vocabulary the admin history table already uses for
// Resend, so one status→color map covers both providers.
const KIT_STATUS_MAP = {
  completed: 'sent',
  sending: 'queued',
  scheduled: 'queued',
  aborted: 'cancelled',
  draft: 'draft',
};

/**
 * Recent Kit broadcasts, mapped to the same shape as the Resend history
 * endpoint: { id, name, status, createdAt, sentAt, subject }.
 *
 * @returns {Promise<{ok: boolean, status?: number, broadcasts?: object[]}>}
 */
export async function kitListBroadcasts(env) {
  const res = await kitFetch(env, '/broadcasts?per_page=50');
  const result = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Kit list broadcasts error ${res.status}:`, JSON.stringify(result));
    return { ok: false, status: res.status };
  }
  const broadcasts = (result.broadcasts || []).map(b => ({
    id: b.id,
    name: b.description || b.subject || '(untitled)',
    status: KIT_STATUS_MAP[b.status] || b.status || 'draft',
    createdAt: b.created_at,
    sentAt: b.status === 'completed' ? (b.send_at || b.published_at || null) : null,
    subject: b.subject || null,
  }));
  return { ok: true, broadcasts };
}
