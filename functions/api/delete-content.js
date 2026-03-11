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

const ALLOWED_WRITE_PREFIXES = ['src/content/', 'public/financials/'];

function isPathAllowed(path) {
  if (!path || path.includes('..') || path.includes('//') || path.startsWith('/')) return false;
  return ALLOWED_WRITE_PREFIXES.some(prefix => path.startsWith(prefix));
}

export async function onRequestPost(context) {
  try {
    const { GITHUB_TOKEN } = context.env;
    const { path, sha, message } = await context.request.json();

    if (!path || !sha || !message) {
      return Response.json(
        { success: false, error: 'Missing required fields: path, sha, message' },
        { status: 400 }
      );
    }

    if (!isPathAllowed(path)) {
      return Response.json(
        { success: false, error: 'Path not allowed' },
        { status: 403 }
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
        { status: response.status }
      );
    }

    return Response.json({ success: true }, {});
  } catch (err) {
    console.error("[delete-content]", err);
    return Response.json(
      { success: false, error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
