// Auth endpoint - validates passphrase
export const prerender = false;

export async function POST({ request, locals }) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const { passphrase } = await request.json();
    const expected = locals.runtime?.env?.ADMIN_PASSPHRASE;

    if (!expected) {
      return new Response(
        JSON.stringify({ error: 'ADMIN_PASSPHRASE not configured in environment' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (passphrase === expected) {
      const encoder = new TextEncoder();
      const data = encoder.encode(expected + new Date().toISOString().slice(0, 10));
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const token = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      return new Response(
        JSON.stringify({ success: true, token }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Invalid passphrase' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Bad request' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
