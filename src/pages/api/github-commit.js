// GitHub commit endpoint - commits content JSON files to the repo
export const prerender = false;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function POST({ request, locals }) {
  const env = locals.runtime?.env;
  const githubToken = env?.GITHUB_TOKEN;
  const githubRepo = env?.GITHUB_REPO || 'pranney82/soard';
  const branch = env?.GITHUB_BRANCH || 'main';

  if (!githubToken) {
    return new Response(
      JSON.stringify({ error: 'GITHUB_TOKEN not configured' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const { files, message } = await request.json();

    if (!files || files.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No files to commit' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const headers = {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };

    const apiBase = `https://api.github.com/repos/${githubRepo}`;

    // 1. Get the current commit SHA
    const refRes = await fetch(`${apiBase}/git/ref/heads/${branch}`, { headers });
    if (!refRes.ok) {
      const err = await refRes.text();
      return new Response(
        JSON.stringify({ error: `Failed to get branch ref: ${refRes.status}`, details: err }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const refData = await refRes.json();
    const latestCommitSha = refData.object.sha;

    // 2. Get the tree SHA
    const commitRes = await fetch(`${apiBase}/git/commits/${latestCommitSha}`, { headers });
    const commitData = await commitRes.json();
    const baseTreeSha = commitData.tree.sha;

    // 3. Create blobs
    const tree = [];
    for (const file of files) {
      const blobRes = await fetch(`${apiBase}/git/blobs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: typeof file.content === 'string' ? file.content : JSON.stringify(file.content, null, 2),
          encoding: 'utf-8',
        }),
      });
      const blobData = await blobRes.json();
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blobData.sha });
    }

    // 4. Create tree
    const treeRes = await fetch(`${apiBase}/git/trees`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ base_tree: baseTreeSha, tree }),
    });
    const treeData = await treeRes.json();

    // 5. Create commit
    const newCommitRes = await fetch(`${apiBase}/git/commits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: message || 'Update content via SOARD Admin',
        tree: treeData.sha,
        parents: [latestCommitSha],
      }),
    });
    const newCommitData = await newCommitRes.json();

    // 6. Update branch ref
    const updateRefRes = await fetch(`${apiBase}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sha: newCommitData.sha }),
    });

    if (!updateRefRes.ok) {
      const err = await updateRefRes.text();
      return new Response(
        JSON.stringify({ error: `Failed to update ref: ${updateRefRes.status}`, details: err }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        commit: { sha: newCommitData.sha, message: newCommitData.message, url: newCommitData.html_url },
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

export async function GET({ request, locals }) {
  const env = locals.runtime?.env;
  const githubToken = env?.GITHUB_TOKEN;
  const githubRepo = env?.GITHUB_REPO || 'pranney82/soard';

  try {
    const url = new URL(request.url);
    const path = url.searchParams.get('path');

    if (!path) {
      return new Response(
        JSON.stringify({ error: 'Missing path parameter' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const response = await fetch(
      `https://api.github.com/repos/${githubRepo}/contents/${path}`,
      {
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (response.status === 404) {
      return new Response(
        JSON.stringify({ exists: false }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();

    if (Array.isArray(data)) {
      return new Response(
        JSON.stringify({
          exists: true,
          type: 'directory',
          files: data.map(f => ({ name: f.name, path: f.path, type: f.type })),
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const content = atob(data.content.replace(/\n/g, ''));
    return new Response(
      JSON.stringify({ exists: true, type: 'file', content, sha: data.sha }),
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
