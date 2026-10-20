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
    signal: AbortSignal.timeout(20000), // a hung Kit call never holds a signup or the heartbeat
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
    const subscriberId = (await res.json().catch(() => ({})))?.subscriber?.id;

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
    // A family who first only asked to hear when applications open has now
    // asked for the newsletter too: list mail may reach them from here on
    if (opts.source === 'newsletter' && subscriberId) {
      const onlyId = await kitTagId(env, WAITLIST_ONLY_TAG, { create: false });
      if (onlyId) await kitUntagSubscriber(env, onlyId, subscriberId);
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

/**
 * Subscribers who only asked to hear when applications open (they came in
 * through the waitlist and weren't on the list before). Sends to "all
 * subscribers" leave them out, so the one email they asked for is the only
 * one they get, and nobody unsubscribes from Kit over a newsletter they never
 * wanted and then misses the opening. Subscribing to the newsletter takes it off.
 */
export const WAITLIST_ONLY_TAG = 'Application Waitlist only (no newsletter)';

/**
 * Find a tag id by name, creating the tag on first use (unless
 * `create: false`, which answers null for a tag that isn't there). Never throws.
 */
export async function kitTagId(env, name, { create = true } = {}) {
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
    if (!create) return null;
    const created = await kitFetch(env, '/tags', { method: 'POST', body: JSON.stringify({ name }) });
    const body = await created.json().catch(() => ({}));
    const id = body.tag?.id;
    if (!created.ok || !id) { console.error(`Kit create tag "${name}" error ${created.status}:`, JSON.stringify(body)); return null; }
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

/** Take a tag off a subscriber (by Kit subscriber id). Never throws. */
export async function kitUntagSubscriber(env, tagId, subscriberId) {
  if (!kitConfigured(env) || !tagId || !subscriberId) return false;
  try {
    const res = await kitFetch(env, `/tags/${tagId}/subscribers/${subscriberId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) { console.error(`Kit untag error ${res.status}: ${await res.text()}`); return false; }
    return true;
  } catch (err) {
    console.error('Kit untag failed:', err);
    return false;
  }
}

/**
 * Create or find a subscriber. Kit answers 201 for a new one and 200 for an
 * address it already had (state then is whatever it was, e.g. "cancelled"
 * for someone who unsubscribed). Never throws.
 * @returns {Promise<{ok: boolean, id?: number, state?: string, created?: boolean, status?: number, error?: string}>}
 */
export async function kitUpsertSubscriber(env, email, { firstName = null } = {}) {
  if (!kitConfigured(env)) return { ok: false, error: 'KIT_API_KEY is not set', status: 0 };
  try {
    const res = await kitFetch(env, '/subscribers', {
      method: 'POST',
      body: JSON.stringify({ email_address: email, ...(firstName ? { first_name: firstName } : {}), state: 'active' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.subscriber?.id) {
      const error = Array.isArray(body.errors) ? body.errors.join('; ') : (body.error || `HTTP ${res.status}`);
      return { ok: false, status: res.status, error: `Kit: ${error}` };
    }
    return { ok: true, id: body.subscriber.id, state: body.subscriber.state || 'active', created: res.status === 201, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: `Kit: ${err.message}` };
  }
}

/** Tag a subscriber by Kit id (the subscriber must exist). Never throws. */
export async function kitTagSubscriberId(env, tagId, subscriberId) {
  if (!kitConfigured(env) || !tagId || !subscriberId) return false;
  try {
    const res = await kitFetch(env, `/tags/${tagId}/subscribers/${subscriberId}`, { method: 'POST', body: '{}' });
    if (!res.ok) { console.error(`Kit tag subscriber ${subscriberId} error ${res.status}: ${await res.text()}`); return false; }
    return true;
  } catch (err) {
    console.error('Kit tag subscriber failed:', err);
    return false;
  }
}

/**
 * Tag up to 100 subscribers in one call (Kit's limit for an answer on the
 * spot; more would be queued without one). Never throws.
 * @returns {Promise<{ok: boolean, tagged: number[], failed: number[], error?: string}>}
 */
export async function kitBulkTag(env, tagId, subscriberIds) {
  const ids = [...new Set((subscriberIds || []).map(Number).filter(Number.isFinite))].slice(0, 100);
  if (!ids.length) return { ok: true, tagged: [], failed: [] };
  if (!kitConfigured(env)) return { ok: false, tagged: [], failed: ids, error: 'KIT_API_KEY is not set' };
  try {
    const res = await kitFetch(env, '/bulk/tags/subscribers', {
      method: 'POST',
      body: JSON.stringify({ taggings: ids.map(subscriber_id => ({ tag_id: tagId, subscriber_id })) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = Array.isArray(body.errors) ? body.errors.join('; ') : (body.error || `HTTP ${res.status}`);
      return { ok: false, tagged: [], failed: ids, error: `Kit: ${error}` };
    }
    // Each failure names the tagging it was for
    const failed = new Set((body.failures || []).map(f => Number(f.tagging?.subscriber_id ?? f.subscriber_id)).filter(Number.isFinite));
    return { ok: true, tagged: ids.filter(id => !failed.has(id)), failed: [...failed] };
  } catch (err) {
    return { ok: false, tagged: [], failed: ids, error: `Kit: ${err.message}` };
  }
}

/**
 * One page of a tag's subscribers, every state (so unsubscribes show up).
 * @returns {Promise<{ok: boolean, subscribers?: object[], next?: string|null, error?: string}>}
 */
export async function kitTagSubscribersPage(env, tagId, { after = null, perPage = 1000 } = {}) {
  if (!kitConfigured(env)) return { ok: false, error: 'KIT_API_KEY is not set' };
  try {
    const q = new URLSearchParams({ per_page: String(perPage), status: 'all' });
    if (after) q.set('after', after);
    const res = await kitFetch(env, `/tags/${tagId}/subscribers?${q}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `Kit: HTTP ${res.status}` };
    return {
      ok: true,
      subscribers: (body.subscribers || []).map(x => ({ id: x.id, email: String(x.email_address || '').toLowerCase(), state: x.state || null, taggedAt: x.tagged_at || x.created_at || null })),
      next: body.pagination?.has_next_page ? body.pagination.end_cursor : null,
    };
  } catch (err) {
    return { ok: false, error: `Kit: ${err.message}` };
  }
}

/**
 * Delete a broadcast that hasn't started sending (a scheduled one is fine).
 * → { ok } , or { ok: false, tooLate: true } when Kit says it's sending or sent. Never throws.
 */
export async function kitDeleteBroadcast(env, id) {
  if (!kitConfigured(env) || !Number.isFinite(Number(id))) return { ok: false, error: 'no broadcast' };
  try {
    const res = await kitFetch(env, `/broadcasts/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) return { ok: true };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, tooLate: res.status === 422, error: `Kit: HTTP ${res.status} ${body.slice(0, 160)}` };
  } catch (err) {
    return { ok: false, status: 0, error: `Kit: ${err.message}` };
  }
}

/**
 * Is the key good, and can the account send? The account's name, its
 * default sending address and whether Kit has verified it. Never throws.
 */
export async function kitAccount(env) {
  if (!kitConfigured(env)) return { ok: false, error: 'KIT_API_KEY is not set' };
  try {
    const res = await kitFetch(env, '/account');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: res.status === 401 ? 'Kit turned down the site\'s key (KIT_API_KEY)' : `Kit: HTTP ${res.status}` };
    const from = (body.account?.sending_addresses || []).find(a => a.is_default) || body.account?.sending_addresses?.[0] || null;
    return {
      ok: true,
      name: body.account?.name || null,
      from: from ? { email: from.email_address, name: from.from_name || null, verified: from.is_verified !== false } : null,
      plan: body.account?.plan ? { limit: body.account.plan.subscriber_limit ?? null, trialEnds: body.account.plan.trial_lapse_date || null, cancelsAt: body.account.plan.cancels_at || null } : null,
    };
  } catch (err) {
    return { ok: false, status: 0, error: `Kit: ${err.message}` };
  }
}

/**
 * A broadcast's state and numbers: Kit's status (draft | scheduled | sending
 * | completed | …), recipients, opens and clicks. Never throws.
 */
export async function kitBroadcastStats(env, id) {
  if (!kitConfigured(env) || !Number.isFinite(Number(id))) return { ok: false, error: 'no broadcast' };
  try {
    const res = await kitFetch(env, `/broadcasts/${id}/stats`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: `Kit: HTTP ${res.status}` };
    const st = body.broadcast?.stats || {};
    return {
      ok: true,
      status: st.status || null,
      progress: Number.isFinite(st.progress) ? st.progress : null,
      recipients: st.recipients ?? null,
      opened: st.emails_opened ?? null,
      openRate: st.open_rate ?? null,
      clicks: st.total_clicks ?? null,
      clickRate: st.click_rate ?? null,
      unsubscribes: st.unsubscribes ?? null,
    };
  } catch (err) {
    return { ok: false, status: 0, error: `Kit: ${err.message}` };
  }
}

/**
 * Create a broadcast. Without `sendAt` it's a DRAFT (send_at: null) — the
 * admin reviews & sends from the Kit dashboard, narrowing the audience there.
 * With `sendAt` (ISO) Kit schedules it and sends on its own; `audience`
 * ({ type: 'all' } | { type: 'tag'|'segment', id }) picks who gets it, and
 * omitting it means every active subscriber.
 *
 * @returns {Promise<{ok: boolean, status?: number, error?: string, broadcast?: object}>}
 */
export async function kitCreateBroadcast(env, { subject, previewText, description, html, sendAt = null, audience = null }) {
  const body = {
    subject,
    preview_text: previewText || '',
    description,
    content: html,
    public: false,
    send_at: sendAt,
  };
  const filter = kitSubscriberFilter(audience);
  if (filter) body.subscriber_filter = filter;
  // "Everyone" means everyone who asked for list mail: not the families who
  // only asked to hear when applications open (see WAITLIST_ONLY_TAG)
  const onlyWaitlist = filter ? null : await kitTagId(env, WAITLIST_ONLY_TAG, { create: false });
  if (onlyWaitlist) body.subscriber_filter = [{ all: null, any: null, none: [{ type: 'tag', ids: [onlyWaitlist] }] }];
  const templateId = parseInt(env.KIT_EMAIL_TEMPLATE_ID, 10);
  if (Number.isFinite(templateId)) body.email_template_id = templateId;

  let res = await kitFetch(env, '/broadcasts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (res.status === 422 && onlyWaitlist) {
    // Kit turned the leave-out filter down: the email matters more than the filter
    console.error(`Kit refused the waitlist-only filter (${await res.text()}); sending to every subscriber`);
    delete body.subscriber_filter;
    res = await kitFetch(env, '/broadcasts', { method: 'POST', body: JSON.stringify(body) });
  }
  const result = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Kit broadcast error ${res.status}:`, JSON.stringify(result));
    const error = Array.isArray(result.errors) ? result.errors.join('; ') : (result.error || `HTTP ${res.status}`);
    return { ok: false, status: res.status, error };
  }
  return { ok: true, broadcast: result.broadcast || result };
}

/**
 * Rewrite a broadcast, but only while it is still an unsent draft. Never
 * touches one staff scheduled or sent. Never throws.
 *
 * @returns {Promise<{ok: boolean, status?: string, error?: string}>} status is
 *   Kit's (draft | scheduled | sending | completed | aborted) when not a draft
 */
export async function kitUpdateDraft(env, id, { subject, previewText, description, html }) {
  if (!kitConfigured(env) || !Number.isFinite(Number(id))) return { ok: false, error: 'no draft' };
  try {
    const cur = await kitFetch(env, `/broadcasts/${id}`);
    const got = await cur.json().catch(() => ({}));
    if (!cur.ok) return { ok: false, error: `HTTP ${cur.status}` };
    const b = got.broadcast || got;
    if (b.status !== 'draft' || b.send_at || b.published_at) return { ok: false, status: b.status || 'sent' };
    const res = await kitFetch(env, `/broadcasts/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ subject, preview_text: previewText || '', description, content: html }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function kitSubscriberFilter(audience) {
  const id = parseInt(audience?.id, 10);
  if (!audience || !['tag', 'segment'].includes(audience.type) || !Number.isFinite(id)) return null;
  return [{ all: [{ type: audience.type, ids: [id] }], any: null, none: null }];
}

/**
 * Tags and segments the admin can aim an automatic send at, with tag
 * subscriber counts so the picker can show list sizes.
 *
 * @returns {Promise<{ok: boolean, error?: string, tags?: object[], segments?: object[]}>}
 */
export async function kitListAudiences(env) {
  if (!kitConfigured(env)) return { ok: false, error: 'KIT_API_KEY is not set' };
  const [tagsRes, segRes] = await Promise.all([
    kitFetch(env, '/tags?per_page=500&include=subscriber_count'),
    kitFetch(env, '/segments?per_page=500'),
  ]);
  const tags = await tagsRes.json().catch(() => ({}));
  const segs = await segRes.json().catch(() => ({}));
  if (!tagsRes.ok) return { ok: false, error: `Kit tags: HTTP ${tagsRes.status}` };
  return {
    ok: true,
    tags: (tags.tags || []).map(t => ({ id: t.id, name: t.name, count: t.subscriber_count ?? null })),
    segments: segRes.ok ? (segs.segments || []).map(x => ({ id: x.id, name: x.name })) : [],
  };
}

// Kit statuses → the short vocabulary the admin history table colors by
// (sent / queued / cancelled / draft).
const KIT_STATUS_MAP = {
  completed: 'sent',
  sending: 'queued',
  scheduled: 'queued',
  aborted: 'cancelled',
  draft: 'draft',
};

/**
 * Recent Kit broadcasts, in the shape the admin history table reads:
 * { id, name, status, createdAt, sentAt, subject }.
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
