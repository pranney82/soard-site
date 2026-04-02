/**
 * GET /api/newsletter-lists
 *
 * Fetches all audiences from Resend API.
 * Admin-only (behind Cloudflare Access middleware).
 *
 * Required env vars: RESEND_API_KEY
 * Returns: { ok: true, lists: [{ id, name, memberCount }] }
 */

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

export async function onRequestGet(context) {
  const apiKey = context.env.RESEND_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ ok: false, error: 'RESEND_API_KEY is not configured.' }),
      { status: 503, headers: cors }
    );
  }

  try {
    const res = await fetch('https://api.resend.com/audiences', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`Resend API error ${res.status}: ${body}`);
      return new Response(
        JSON.stringify({ ok: false, error: `Resend API returned ${res.status}.` }),
        { status: 502, headers: cors }
      );
    }

    const data = await res.json();
    const lists = (data.data || []).map(a => ({
      id: a.id,
      name: a.name,
      memberCount: 0, // Resend doesn't return count in list endpoint
    }));

    return new Response(
      JSON.stringify({ ok: true, lists }),
      { status: 200, headers: cors }
    );
  } catch (err) {
    console.error('Newsletter lists error:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'Failed to fetch audiences from Resend.' }),
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
