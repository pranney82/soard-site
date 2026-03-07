/**
 * GET /api/list-content?dir=src/content/kids
 * Lists all JSON files in a directory AND returns their parsed contents.
 *
 * Uses two fast approaches:
 *   1. Git Trees API — one call to get all file paths + SHAs
 *   2. raw.githubusercontent.com — fetch file contents without API rate limits
 *
 * This handles 133+ files in a few seconds vs the old approach timing out.
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
      'User-Agent': 'SOARD-Admin',
    };

    // Step 1: Get entire repo tree in one API call
    const treeRes = await fetch(
      `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`,
      { headers: { ...headers, 'Accept': 'application/vnd.github.v3+json' } }
    );

    if (!treeRes.ok) {
      return Response.json(
        { success: false, error: `GitHub Trees API error: ${treeRes.status}` },
        { status: treeRes.status, headers: cors }
      );
    }

    const tree = await treeRes.json();

    // Filter to JSON files in the requested directory
    const dirPrefix = dir.endsWith('/') ? dir : dir + '/';
    const jsonFiles = tree.tree.filter(
      f => f.type === 'blob'
        && f.path.startsWith(dirPrefix)
        && f.path.endsWith('.json')
        && !f.path.slice(dirPrefix.length).includes('/')  // no subdirectories
    );

    // Step 2: Fetch all file contents from raw.githubusercontent.com in parallel
    // This bypasses API rate limits — much faster for 100+ files
    const BATCH_SIZE = 25;
    const items = [];

    for (let i = 0; i < jsonFiles.length; i += BATCH_SIZE) {
      const batch = jsonFiles.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (file) => {
          try {
            const rawUrl = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${file.path}`;
            const res = await fetch(rawUrl, { headers });
            if (!res.ok) return null;
            const text = await res.text();
            return {
              name: file.path.split('/').pop(),
              path: file.path,
              sha: file.sha,
              content: JSON.parse(text),
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
