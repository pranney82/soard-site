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

// ─── SHA Cache ──────────────────────────────────────────────────────
// Caches file SHAs in module scope (survives across requests in same isolate).
// Eliminates the GET-before-PUT pattern — saves one GitHub API call per write.
// Cache is keyed by "repo:branch:path" and updated after every successful PUT/DELETE.
const _shaCache = new Map();
const SHA_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes — short enough to limit stale hits, long enough to help sequential saves

function shaCacheKey(repo, branch, path) {
  return `${repo}:${branch}:${path}`;
}

function getCachedSha(repo, branch, path) {
  const entry = _shaCache.get(shaCacheKey(repo, branch, path));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _shaCache.delete(shaCacheKey(repo, branch, path));
    return null;
  }
  return entry.sha;
}

function setCachedSha(repo, branch, path, sha) {
  _shaCache.set(shaCacheKey(repo, branch, path), {
    sha,
    expiresAt: Date.now() + SHA_CACHE_TTL_MS,
  });
}

function clearCachedSha(repo, branch, path) {
  _shaCache.delete(shaCacheKey(repo, branch, path));
}

/**
 * Get the current SHA of a file (needed for updates and deletes).
 * Returns null if the file doesn't exist yet.
 * Checks cache first to avoid unnecessary API calls.
 */
async function getFileSha(token, repo, path, branch) {
  // Check cache first
  const cached = getCachedSha(repo, branch, path);
  if (cached) return cached;

  const url = `${API}/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`;
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  const data = await res.json();

  // Cache the fetched SHA
  setCachedSha(repo, branch, path, data.sha);
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
    // SHA mismatch (409) — clear cache, fetch fresh SHA, retry once
    if (res.status === 409 && sha) {
      clearCachedSha(GITHUB_REPO, GITHUB_BRANCH, path);
      const freshSha = await getFileSha(GITHUB_TOKEN, GITHUB_REPO, path, GITHUB_BRANCH);
      if (freshSha && freshSha !== sha) {
        body.sha = freshSha;
        const retry = await fetch(url, {
          method: 'PUT',
          headers: headers(GITHUB_TOKEN),
          body: JSON.stringify(body),
        });
        if (retry.ok) {
          const retryData = await retry.json();
          setCachedSha(GITHUB_REPO, GITHUB_BRANCH, path, retryData.content?.sha);
          return;
        }
        const retryErr = await retry.text();
        throw new Error(`GitHub commit failed after retry (${retry.status}): ${retryErr}`);
      }
    }
    const err = await res.text();
    throw new Error(`GitHub commit failed (${res.status}): ${err}`);
  }

  // Cache the new SHA from the response — avoids GET on next write
  const responseData = await res.json();
  if (responseData.content?.sha) {
    setCachedSha(GITHUB_REPO, GITHUB_BRANCH, path, responseData.content.sha);
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

  // Clear the cache entry for the deleted file
  clearCachedSha(GITHUB_REPO, GITHUB_BRANCH, path);
}
