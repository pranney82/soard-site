/**
 * POST /api/save-content
 * Creates or updates a file in the GitHub repo.
 * Expects JSON body:
 *   {
 *     path: "src/content/kids/amari.json",
 *     content: "{ ... }",        // file content as string
 *     message: "Update amari",   // commit message
 *     sha: "abc123..."           // required for updates, omit for new files
 *   }
 *
 * Environment variables needed:
 *   GITHUB_TOKEN
 */

const REPO = 'pranney82/soard';

export async function onRequestPost(context) {
  try {
    const { GITHUB_TOKEN } = context.env;
    const { path, content, message, sha } = await context.request.json();

    if (!path || content === undefined || !message) {
      return Response.json(
        { success: false, error: 'Missing required fields: path, content, message' },
        { status: 400 }
      );
    }

    // Encode content to base64 (handle UTF-8)
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    const base64 = btoa(String.fromCharCode(...bytes));

    const body = {
      message,
      content: base64,
    };

    // Include SHA if updating an existing file
    if (sha) {
      body.sha = sha;
    }

    const response = await fetch(
      `https://api.github.com/repos/${REPO}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'SOARD-Admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      return Response.json(
        { success: false, error: result.message || `GitHub error: ${response.status}` },
        { status: response.status }
      );
    }

    return Response.json(
      {
        success: true,
        sha: result.content.sha,
        path: result.content.path,
      },
      {}
    );
  } catch (err) {
    return Response.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
,
  });
}
