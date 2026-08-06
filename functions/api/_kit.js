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
 * @returns {Promise<{configured: boolean, ok: boolean}>}
 */
export async function kitSubscribe(env, email) {
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

    return { configured: true, ok: true };
  } catch (err) {
    console.error('Kit subscribe failed:', err);
    return { configured: true, ok: false };
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
