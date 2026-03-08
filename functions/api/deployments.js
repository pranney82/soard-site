/**
 * GET /api/deployments
 * Returns recent Cloudflare Pages deployments for the SOARD project.
 * Falls back to GitHub commits if CF Pages API is unavailable.
 *
 * Environment variables needed:
 *   GITHUB_TOKEN
 *   CF_ACCOUNT_ID (optional — enables CF Pages deployment status)
 *   CF_PAGES_TOKEN (optional — API token with Pages:Read permission)
 */

const REPO = 'pranney82/soard';
const CF_PROJECT = 'soard-site';

export async function onRequestGet(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const { GITHUB_TOKEN, CF_ACCOUNT_ID, CF_PAGES_TOKEN } = context.env;

    if (!GITHUB_TOKEN) {
      return Response.json(
        { success: false, error: 'Missing GITHUB_TOKEN' },
        { status: 500, headers: cors }
      );
    }

    // Try Cloudflare Pages deployments first
    let cfDeploys = null;
    if (CF_ACCOUNT_ID && CF_PAGES_TOKEN) {
      try {
        const cfRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${CF_PROJECT}/deployments?per_page=25`,
          {
            headers: {
              'Authorization': `Bearer ${CF_PAGES_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );
        if (cfRes.ok) {
          const cfData = await cfRes.json();
          if (cfData.success && cfData.result) {
            cfDeploys = cfData.result.map(d => ({
              id: d.id,
              url: d.url || null,
              environment: d.environment || 'production',
              status: d.latest_stage?.status || 'unknown',
              stageName: d.latest_stage?.name || 'deploy',
              startedOn: d.latest_stage?.started_on || d.created_on,
              endedOn: d.latest_stage?.ended_on || null,
              commitHash: d.deployment_trigger?.metadata?.commit_hash || null,
              commitMessage: d.deployment_trigger?.metadata?.commit_message || null,
              branch: d.deployment_trigger?.metadata?.branch || 'main',
              createdOn: d.created_on,
            }));
          }
        }
      } catch (_) {
        // CF Pages API failed — fall through to GitHub
      }
    }

    // Always fetch GitHub commits for extra context
    const ghHeaders = {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'SOARD-Admin',
    };

    const ghRes = await fetch(
      `https://api.github.com/repos/${REPO}/commits?sha=main&per_page=25`,
      { headers: ghHeaders }
    );

    let commits = [];
    if (ghRes.ok) {
      const ghData = await ghRes.json();
      commits = ghData.map(c => ({
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        message: c.commit.message.split('\n')[0],
        fullMessage: c.commit.message,
        author: c.commit.author?.name || c.author?.login || 'Unknown',
        avatar: c.author?.avatar_url || null,
        date: c.commit.author?.date || null,
        url: c.html_url,
      }));
    }

    // Merge: if we have CF deploys, enrich with commit data
    if (cfDeploys) {
      const commitMap = {};
      commits.forEach(c => { commitMap[c.sha] = c; commitMap[c.shortSha] = c; });

      const deploys = cfDeploys.map(d => {
        const commit = d.commitHash ? (commitMap[d.commitHash] || commitMap[d.commitHash?.slice(0, 7)]) : null;
        return {
          ...d,
          author: commit?.author || null,
          avatar: commit?.avatar || null,
          commitUrl: commit?.url || null,
          commitMessage: d.commitMessage || commit?.message || null,
        };
      });

      return Response.json(
        { success: true, source: 'cloudflare', deploys, commits },
        { headers: cors }
      );
    }

    // Fallback: use commits as deploy proxies
    const deploys = commits.map(c => ({
      id: c.sha,
      environment: 'production',
      status: 'success', // assume success — we can't know from GitHub alone
      stageName: 'deploy',
      commitHash: c.sha,
      commitMessage: c.message,
      branch: 'main',
      createdOn: c.date,
      startedOn: c.date,
      endedOn: null,
      author: c.author,
      avatar: c.avatar,
      commitUrl: c.url,
      url: null,
    }));

    return Response.json(
      { success: true, source: 'github', deploys, commits },
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
