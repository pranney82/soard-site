/**
 * SOARD Press Monitor — Automated Media Mention Scanner
 * =====================================================
 * Cloudflare Worker with Cron Trigger
 *
 * Runs twice a month (1st and 15th at 9am ET / 14:00 UTC).
 * 1. Scans Google News RSS for SOARD-related mentions
 * 2. Compares against existing press articles in the GitHub repo
 * 3. Compares against previously-seen URLs stored in D1
 * 4. Emails you only when genuinely new articles are found
 * 5. Stores seen URLs in D1 so you're never notified twice
 *
 * Environment variables needed:
 *   GITHUB_TOKEN    — GitHub PAT (read access to pranney82/soard)
 *   RESEND_API_KEY  — Resend.com API key (free tier: 100 emails/day)
 *   NOTIFY_EMAIL    — Email address to send notifications to
 *   DB              — D1 database binding
 */

const SEARCH_QUERIES = [
  '"Sunshine on a Ranney Day"',
  '"SOARD" charity Atlanta',
  '"Peter Ranney" nonprofit',
  '"Holly Ranney" nonprofit',
  '"Sunny and Ranney" Roswell',
];

const GITHUB_REPO = 'pranney82/soard';
const PRESS_PATH = 'src/content/press';

// ─── Entry Point ─────────────────────────────────────────────────

export default {
  // Cron trigger handler
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPressScan(env));
  },

  // Manual trigger via HTTP (for testing)
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      try {
        const result = await runPressScan(env);
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === '/seed') {
      try {
        const count = await seedFromGitHub(env);
        return Response.json({ success: true, seeded: count });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    if (url.pathname === '/status') {
      try {
        const { results } = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM press_seen_urls'
        ).all();
        return Response.json({
          tracked_urls: results[0].count,
          info: 'GET /run to manually trigger scan, GET /seed to reseed from GitHub',
        });
      } catch {
        return Response.json({
          error: 'D1 not configured or table not created. Run the migration first.',
        }, { status: 500 });
      }
    }

    return Response.json({
      name: 'SOARD Press Monitor',
      endpoints: {
        '/status': 'Check how many URLs are being tracked',
        '/run': 'Manually trigger a scan (same as cron)',
        '/seed': 'Re-seed known URLs from GitHub repo',
      },
    });
  },
};

// ─── Main Scan Logic ─────────────────────────────────────────────

async function runPressScan(env) {
  // 1. Ensure D1 table exists
  await ensureTable(env);

  // 2. Re-seed known URLs from GitHub (keeps D1 in sync with repo)
  const seededCount = await seedFromGitHub(env);

  // 3. Get all known URLs from D1
  const knownUrls = await getKnownUrls(env);

  // 4. Scan Google News RSS
  const mentions = await scanGoogleNews();

  // 5. Filter to genuinely new mentions
  const newMentions = mentions.filter(m => {
    const url = normalizeUrl(m.resolvedUrl || m.link);
    return !knownUrls.has(url);
  });

  // 6. Store new URLs in D1 (so we don't notify again)
  for (const m of newMentions) {
    const url = normalizeUrl(m.resolvedUrl || m.link);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO press_seen_urls (url, title, source_name, discovered_at, origin) VALUES (?, ?, ?, ?, ?)'
    ).bind(url, m.title, m.source, new Date().toISOString(), 'scan').run();
  }

  // 7. Send email if there are new mentions
  if (newMentions.length > 0) {
    await sendNotification(env, newMentions);
  }

  return {
    success: true,
    scanned: mentions.length,
    new: newMentions.length,
    seeded: seededCount,
    newMentions: newMentions.map(m => ({
      title: m.title,
      source: m.source,
      date: m.date,
      url: m.resolvedUrl || m.link,
    })),
  };
}

// ─── D1 Database ─────────────────────────────────────────────────

async function ensureTable(env) {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS press_seen_urls (
      url TEXT PRIMARY KEY,
      title TEXT,
      source_name TEXT,
      discovered_at TEXT,
      origin TEXT DEFAULT 'scan'
    )
  `);
}

async function getKnownUrls(env) {
  const { results } = await env.DB.prepare(
    'SELECT url FROM press_seen_urls'
  ).all();
  return new Set(results.map(r => r.url));
}

// ─── GitHub: Seed existing press article URLs ────────────────────

async function seedFromGitHub(env) {
  const token = env.GITHUB_TOKEN;
  if (!token) return 0;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'SOARD-Press-Monitor/1.0',
  };

  // List all files in src/content/press/
  const listRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${PRESS_PATH}`,
    { headers }
  );
  if (!listRes.ok) return 0;

  const files = await listRes.json();
  const jsonFiles = files.filter(f => f.name.endsWith('.json'));

  // Fetch each file's content in parallel (batches of 15 to be gentle)
  let seeded = 0;
  const batches = chunk(jsonFiles, 15);

  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const res = await fetch(file.download_url, {
          headers: { 'User-Agent': 'SOARD-Press-Monitor/1.0' },
        });
        if (!res.ok) return null;
        const json = await res.json();
        return json;
      })
    );

    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const article = result.value;
      if (!article.url) continue;

      const url = normalizeUrl(article.url);
      try {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO press_seen_urls (url, title, source_name, discovered_at, origin) VALUES (?, ?, ?, ?, ?)'
        ).bind(url, article.title || '', article.outlet || '', new Date().toISOString(), 'github').run();
        seeded++;
      } catch {
        // Ignore duplicate key errors
      }
    }
  }

  return seeded;
}

// ─── Google News RSS Scanning ────────────────────────────────────

async function scanGoogleNews() {
  const allMentions = [];
  const seenLinks = new Set();

  const results = await Promise.allSettled(
    SEARCH_QUERIES.map(q => fetchGoogleNewsRSS(q))
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value) {
      const url = normalizeUrl(item.link);
      if (seenLinks.has(url)) continue;
      seenLinks.add(url);
      allMentions.push(item);
    }
  }

  // Resolve Google News redirects in parallel
  await Promise.allSettled(
    allMentions.map(async (m) => {
      const resolved = await resolveRedirect(m.link);
      if (resolved && resolved !== m.link) {
        m.resolvedUrl = resolved;
      }
    })
  );

  return allMentions;
}

async function fetchGoogleNewsRSS(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SOARDPressMonitor/1.0)' },
  });

  if (!res.ok) return [];

  const xml = await res.text();
  return parseRSSItems(xml, query);
}

function parseRSSItems(xml, query) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const sourceName = extractTag(block, 'source') || '';

    if (title && link) {
      items.push({
        title: decodeEntities(title),
        link: link.trim(),
        pubDate: pubDate || '',
        date: pubDate ? new Date(pubDate).toISOString().split('T')[0] : '',
        source: decodeEntities(sourceName),
        query,
      });
    }
  }

  return items;
}

// ─── Email Notification ──────────────────────────────────────────

async function sendNotification(env, mentions) {
  const apiKey = env.RESEND_API_KEY;
  const toEmail = env.NOTIFY_EMAIL;

  if (!apiKey || !toEmail) {
    console.log('Email not configured. New mentions:', JSON.stringify(mentions));
    return;
  }

  const mentionRows = mentions.map(m => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;">
        <strong>${escapeHtml(m.title)}</strong><br>
        <span style="color:#666;font-size:13px;">${escapeHtml(m.source)} — ${m.date}</span><br>
        <a href="${m.resolvedUrl || m.link}" style="color:#7A00DF;font-size:13px;">${escapeHtml(m.resolvedUrl || m.link)}</a>
      </td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#2D2E33;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h2 style="color:#FFD500;margin:0;font-size:18px;">☀️ SOARD Press Monitor</h2>
        <p style="color:#ccc;margin:6px 0 0;font-size:14px;">${mentions.length} new media mention${mentions.length > 1 ? 's' : ''} found</p>
      </div>
      <div style="border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;overflow:hidden;">
        <table style="width:100%;border-collapse:collapse;">
          ${mentionRows}
        </table>
        <div style="padding:16px 12px;background:#f9f9f9;font-size:13px;color:#666;">
          Add these to your site via the <a href="https://sunshineonaranneyday.com/admin" style="color:#7A00DF;">Admin Panel</a> → Add Press Article.<br>
          This scan ran automatically. You'll be checked again on the 1st or 15th.
        </div>
      </div>
    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'SOARD Press Monitor <press@updates.sunshineonaranneyday.com>',
      to: [toEmail],
      subject: `☀️ ${mentions.length} new SOARD press mention${mentions.length > 1 ? 's' : ''} found`,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend email failed:', err);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

async function resolveRedirect(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SOARDPressMonitor/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    return res.url || url;
  } catch {
    return url;
  }
}

function extractTag(xml, tag) {
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`);
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
