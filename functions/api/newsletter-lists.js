/**
 * GET /api/newsletter-lists
 *
 * Fetches all contact lists from Constant Contact v3 API.
 * Admin-only (behind Cloudflare Access middleware).
 *
 * Required env var: CC_API_TOKEN
 * Returns: { ok: true, lists: [{ id, name, memberCount }] }
 */

export async function onRequestGet(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const token = context.env.CC_API_TOKEN;
  if (!token) {
    return new Response(
      JSON.stringify({ ok: false, error: 'CC_API_TOKEN not configured. Add it in Cloudflare Pages → Settings → Environment Variables.' }),
      { status: 503, headers: cors }
    );
  }

  try {
    const res = await fetch('https://api.cc.email/v3/contact_lists?include_count=true&include_membership_count=all&status=active', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`CC API error ${res.status}: ${body}`);
      return new Response(
        JSON.stringify({ ok: false, error: `Constant Contact API returned ${res.status}. Your token may be expired.` }),
        { status: 502, headers: cors }
      );
    }

    const data = await res.json();
    const lists = (data.lists || []).map(l => ({
      id: l.list_id,
      name: l.name,
      memberCount: l.membership_count || 0,
    }));

    return new Response(
      JSON.stringify({ ok: true, lists }),
      { status: 200, headers: cors }
    );
  } catch (err) {
    console.error('Newsletter lists error:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'Failed to fetch lists from Constant Contact.' }),
      { status: 500, headers: cors }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
