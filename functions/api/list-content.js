/**
 * GET /api/list-content?dir=src/content/kids
 * 
 * Returns file tree (paths + SHAs) plus content in pages.
 * Stays under Cloudflare's 50 subrequest limit per invocation.
 *
 * Params:
 *   dir    — directory path (required)
 *   page   — page number, 0-indexed (default: 0)
 *   limit  — files per page (default: 45, max: 45)
 *
 * Response includes `total`, `page`, `pages` so frontend knows when to stop.
 *
 * Environment variables needed:
 *   GITHUB_TOKEN
 */

const REPO = 'pranney82/soard';
const BRANCH = 'main';
const MAX_PER_PAGE = 45; // Leave room for 1 tree call + 45 file fetches = 46 < 50

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
    const page = parseInt(url.searchParams.get('page') || '0', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || String(MAX_PER_PAGE), 10), MAX_PER_PAGE);

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

    // Step 1: Get repo tree (1 subrequest)
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

    // Filter to JSON files in directory
    const dirPrefix = dir.endsWith('/') ? dir : dir + '/';
    const jsonFiles = tree.tree.filter(
      f => f.type === 'blob'
        && f.path.startsWith(dirPrefix)
        && f.path.endsWith('.json')
        && !f.path.slice(dirPrefix.length).includes('/')
    );

    const total = jsonFiles.length;
    const pages = Math.ceil(total / limit);
    const start = page * limit;
    const pageFiles = jsonFiles.slice(start, start + limit);

    // Step 2: Fetch this page of files in parallel (up to 45 subrequests)
    const results = await Promise.all(
      pageFiles.map(async (file) => {
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

    const items = results.filter(Boolean);

    return Response.json(
      { success: true, count: items.length, total, page, pages, items },
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
