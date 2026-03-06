/**
 * POST /api/delete-content
 * Deletes a file from the GitHub repo.
 * Expects JSON body:
 *   {
 *     path: "src/content/kids/amari.json",
 *     sha: "abc123...",
 *     message: "Remove amari"
 *   }
 *
 * Environment variables needed:
 *   GITHUB_TOKEN
 */

const REPO = 'pranney82/soard';

export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const { GITHUB_TOKEN } = context.env;
    const { path, sha, message } = await context.request.json();

    if (!path || !sha || !message) {
      return Response.json(
        { success: false, error: 'Missing required fields: path, sha, message' },
        { status: 400, headers: cors }
      );
    }

    const response = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${path}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'SOARD-Admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message, sha }),
      }
    );

    if (!response.ok) {
      const result = await response.json();
      return Response.json(
        { success: false, error: result.message || `GitHub error: ${response.status}` },
        { status: response.status, headers: cors }
      );
    }

    return Response.json({ success: true }, { headers: cors });
  } catch (err) {
    return Response.json(
      { success: false, error: err.message },
      { status: 500, headers: cors }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
