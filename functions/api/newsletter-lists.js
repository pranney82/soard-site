/**
 * GET /api/newsletter-lists
 *
 * Fetches all contact lists from Constant Contact v3 API.
 * Admin-only (behind Cloudflare Access middleware).
 *
 * Required env vars: CC_CLIENT_ID, CC_CLIENT_SECRET, CC_REFRESH_TOKEN
 * Returns: { ok: true, lists: [{ id, name, memberCount }] }
 */

import { getCCAccessToken, clearCCTokenCache, CCAuthError } from './_cc-auth.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

export async function onRequestGet(context) {
  let token;
  try {
    token = await getCCAccessToken(context.env);
  } catch (err) {
    if (err instanceof CCAuthError) {
      return new Response(
        JSON.stringify({ ok: false, error: err.message }),
        { status: err.status, headers: cors }
      );
    }
    throw err;
  }

  try {
    let res = await fetch(
      'https://api.cc.email/v3/contact_lists?include_count=true&include_membership_count=all&status=active',
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // If 401, clear cache and retry once with a fresh token
    if (res.status === 401) {
      clearCCTokenCache();
      token = await getCCAccessToken(context.env);
      res = await fetch(
        'https://api.cc.email/v3/contact_lists?include_count=true&include_membership_count=all&status=active',
        { headers: { Authorization: `Bearer ${token}` } }
      );
    }

    if (!res.ok) {
      const body = await res.text();
      console.error(`CC API error ${res.status}: ${body}`);
      return new Response(
        JSON.stringify({ ok: false, error: `Constant Contact API returned ${res.status}.` }),
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
    if (err instanceof CCAuthError) {
      return new Response(
        JSON.stringify({ ok: false, error: err.message }),
        { status: err.status, headers: cors }
      );
    }
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
