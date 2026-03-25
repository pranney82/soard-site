/**
 * GitHub Contents API helper — commits content files directly to the repo.
 *
 * Required env vars:
 *   GITHUB_TOKEN — fine-grained PAT with "Contents: Read and write" permission
 *   GITHUB_REPO  — "owner/repo" (e.g. "pranney82/soard-site")
 *
 * Optional:
 *   GITHUB_BRANCH — branch to commit to (default: "main")
 */

const API = 'https://api.github.com';

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'soard-admin',
  };
}

/**
 * Get the current SHA of a file (needed for updates and deletes).
 * Returns null if the file doesn't exist yet.
 */
async function getFileSha(token, repo, path, branch) {
  const url = `${API}/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`;
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  const data = await res.json();
  return data.sha;
}

/**
 * Create or update a file in the repo.
 *
 * @param {object} env — Cloudflare env bindings
 * @param {string} path — repo-relative path (e.g. "src/content/kids/amari.json")
 * @param {string} content — file content (will be base64-encoded)
 * @param {string} message — commit message
 */
export async function commitFile(env, path, content, message) {
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main' } = env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;

  const sha = await getFileSha(GITHUB_TOKEN, GITHUB_REPO, path, GITHUB_BRANCH);
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const url = `${API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: headers(GITHUB_TOKEN),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub commit failed (${res.status}): ${err}`);
  }
}

/**
 * Delete a file from the repo.
 *
 * @param {object} env — Cloudflare env bindings
 * @param {string} path — repo-relative path
 * @param {string} message — commit message
 */
export async function deleteFile(env, path, message) {
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main' } = env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;

  const sha = await getFileSha(GITHUB_TOKEN, GITHUB_REPO, path, GITHUB_BRANCH);
  if (!sha) return; // file doesn't exist, nothing to delete

  const url = `${API}/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: headers(GITHUB_TOKEN),
    body: JSON.stringify({
      message,
      sha,
      branch: GITHUB_BRANCH,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub delete failed (${res.status}): ${err}`);
  }
}
