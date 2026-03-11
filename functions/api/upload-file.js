/**
 * POST /api/upload-file
 * Uploads a binary file (like a PDF) to the GitHub repo.
 * Expects multipart/form-data with:
 *   - file: the file to upload
 *   - path: destination path in repo (e.g., "public/financials/2024-990.pdf")
 *   - message: commit message
 *
 * Environment variables needed:
 *   GITHUB_TOKEN
 */

const REPO = 'pranney82/soard';

export async function onRequestPost(context) {
  try {
    const { GITHUB_TOKEN } = context.env;
    const formData = await context.request.formData();
    const file = formData.get('file');
    const path = formData.get('path');
    const message = formData.get('message') || `Upload ${file?.name || 'file'}`;

    if (!file || !path) {
      return Response.json(
        { success: false, error: 'Missing file or path' },
        { status: 400 }
      );
    }

    // Read file as ArrayBuffer and convert to base64
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const base64 = btoa(String.fromCharCode(...bytes));

    // Check if file already exists (to get SHA for update)
    let sha = undefined;
    try {
      const checkResponse = await fetch(
        `https://api.github.com/repos/${REPO}/contents/${path}`,
        {
          headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'SOARD-Admin',
          },
        }
      );
      if (checkResponse.ok) {
        const existing = await checkResponse.json();
        sha = existing.sha;
      }
    } catch (e) {
      // File doesn't exist, that's fine
    }

    const body = {
      message,
      content: base64,
    };
    if (sha) body.sha = sha;

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
        path: result.content.path,
        sha: result.content.sha,
        downloadUrl: result.content.download_url,
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
