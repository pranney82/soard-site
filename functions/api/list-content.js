/**
 * GET /api/list-content?dir=src/content/kids
 * Lists all JSON files in a directory AND returns their parsed contents.
 * Single API call replaces N individual reads.
 *
 * Environment variables needed:
 *   GITHUB_TOKEN
 */

const REPO = 'pranney82/soard';
const BRANCH = 'main';

export async function onRequestGet(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache',
  };

  try {
    const { GITHUB_TOKEN } = context.env;
    const url = new URL(context.request.url);
    const dir = url.searchParams.get('dir');

    if (!dir) {
      return Response.json(
        { success: false, error: 'Provide ?dir= parameter' },
        { status: 400, headers: cors }
      );
    }

    const headers = {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'SOARD-Admin',
    };

    // List directory contents
    const listRes = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${dir}?ref=${BRANCH}`,
      { headers }
    );

    if (!listRes.ok) {
      return Response.json(
        { success: false, error: `GitHub error: ${listRes.status}` },
        { status: listRes.status, headers: cors }
      );
    }

    const listing = await listRes.json();
    const jsonFiles = listing.filter(f => f.type === 'file' && f.name.endsWith('.json'));

    // Fetch in batches of 10 to avoid rate limits
    const BATCH_SIZE = 10;
    const items = [];

    for (let i = 0; i < jsonFiles.length; i += BATCH_SIZE) {
      const batch = jsonFiles.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            const res = await fetch(
              `https://api.github.com/repos/${REPO}/contents/${file.path}?ref=${BRANCH}`,
              { headers }
            );
            if (!res.ok) return null;
            const data = await res.json();
            const raw = atob(data.content.replace(/\n/g, ''));
            const decoded = new TextDecoder().decode(
              Uint8Array.from(raw, c => c.charCodeAt(0))
            );
            return {
              name: file.name,
              path: file.path,
              sha: data.sha,
              content: JSON.parse(decoded),
            };
          } catch {
            return null;
          }
        })
      );
      items.push(...results.filter(Boolean));
    }

    return Response.json(
      { success: true, count: items.length, items },
      { headers: cors }
    );
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
