// Image upload endpoint - proxies to Cloudflare Images API
export const prerender = false;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function POST({ request, locals }) {
  const env = locals.runtime?.env;
  const accountId = env?.CF_ACCOUNT_ID;
  const imagesToken = env?.CF_IMAGES_TOKEN;

  if (!accountId || !imagesToken) {
    return new Response(
      JSON.stringify({ error: 'CF_ACCOUNT_ID or CF_IMAGES_TOKEN not configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return new Response(
        JSON.stringify({ error: 'No file provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const uploadForm = new FormData();
    uploadForm.append('file', file);

    const metadata = formData.get('metadata');
    if (metadata) uploadForm.append('metadata', metadata);

    const customId = formData.get('id');
    if (customId) uploadForm.append('id', customId);

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${imagesToken}` },
        body: uploadForm,
      }
    );

    const result = await response.json();

    if (!result.success) {
      return new Response(
        JSON.stringify({ error: 'Cloudflare Images upload failed', details: result.errors }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        image: {
          id: result.result.id,
          filename: result.result.filename,
          variants: result.result.variants,
          uploaded: result.result.uploaded,
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

export async function DELETE({ request, locals }) {
  const env = locals.runtime?.env;
  const accountId = env?.CF_ACCOUNT_ID;
  const imagesToken = env?.CF_IMAGES_TOKEN;

  try {
    const { imageId } = await request.json();
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1/${imageId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${imagesToken}` },
      }
    );
    const result = await response.json();
    return new Response(
      JSON.stringify({ success: result.success }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders });
}
