/**
 * GET /api/read-content?path=src/content/kids/amari.json
 * Reads a file from the GitHub repo.
 *
 * GET /api/read-content?dir=src/content/kids
 * Lists files in a directory.
 *
 * Environment variables needed:
 *   GITHUB_TOKEN
 */

const REPO = 'pranney82/soard';

export async function onRequestGet(context) {
  try {
    const { GITHUB_TOKEN } = context.env;
    const url = new URL(context.request.url);
    const path = url.searchParams.get('path');
    const dir = url.searchParams.get('dir');

    if (!GITHUB_TOKEN) {
      return Response.json(
        { success: false, error: 'Missing GITHUB_TOKEN' },
        { status: 500 }
      );
    }

    const headers = {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'SOARD-Admin',
    };

    // List directory
    if (dir) {
      const response = await fetch(
        `https://api.github.com/repos/${REPO}/contents/${dir}`,
        { headers }
      );

      if (!response.ok) {
        return Response.json(
          { success: false, error: `GitHub API error: ${response.status}` },
          { status: response.status }
        );
      }

      const files = await response.json();
      const fileList = files
        .filter(f => f.type === 'file')
        .map(f => ({
          name: f.name,
          path: f.path,
          sha: f.sha,
          size: f.size,
        }));

      return Response.json({ success: true, files: fileList }, {});
    }

    // Read single file
    if (path) {
      const response = await fetch(
        `https://api.github.com/repos/${REPO}/contents/${path}`,
        { headers }
      );

      if (!response.ok) {
        return Response.json(
          { success: false, error: `GitHub API error: ${response.status}` },
          { status: response.status }
        );
      }

      const file = await response.json();
      const content = atob(file.content.replace(/\n/g, ''));
      // Decode UTF-8 properly
      const decoded = new TextDecoder().decode(
        Uint8Array.from(content, c => c.charCodeAt(0))
      );

      return Response.json(
        {
          success: true,
          content: decoded,
          sha: file.sha,
          name: file.name,
          path: file.path,
        },
        {}
      );
    }

    return Response.json(
      { success: false, error: 'Provide ?path= or ?dir= parameter' },
      { status: 400 }
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
