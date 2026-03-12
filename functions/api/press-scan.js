/**
 * Press Monitor — Scan for SOARD media mentions
 * ==============================================
 * Fetches Google News RSS for multiple search queries,
 * parses results, and returns deduplicated mentions.
 *
 * GET /api/press-scan
 *   Returns { success: true, mentions: [...] }
 *
 * POST /api/press-scan  { action: 'ai-categorize', mentions: [...] }
 *   Uses Workers AI to categorize and clean up mention metadata
 */

const SEARCH_QUERIES = [
  '"Sunshine on a Ranney Day"',
  '"SOARD" charity',
  '"Peter Ranney" nonprofit',
  '"Holly Ranney"',
  '"Sunny and Ranney"',
  '"sunshineonaranneyday"',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── GET: Scan Google News RSS ─────────────────────────────────────

export async function onRequestGet(context) {
  try {
    const allMentions = [];
    const seenLinks = new Set();

    // Fetch all queries in parallel
    const results = await Promise.allSettled(
      SEARCH_QUERIES.map(q => fetchGoogleNewsRSS(q))
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const item of result.value) {
        // Deduplicate by URL
        const normalizedUrl = normalizeUrl(item.link);
        if (seenLinks.has(normalizedUrl)) continue;
        seenLinks.add(normalizedUrl);
        allMentions.push(item);
      }
    }

    // Sort by date descending
    allMentions.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    return Response.json({ success: true, mentions: allMentions }, { headers: CORS });
  } catch (err) {
    return Response.json(
      { success: false, error: err.message },
      { status: 500, headers: CORS }
    );
  }
}

// ─── POST: AI categorization ──────────────────────────────────────

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    if (body.action === 'ai-categorize' && body.mentions?.length) {
      const ai = context.env.AI;
      if (!ai) {
        return Response.json(
          { success: false, error: 'Workers AI not configured' },
          { status: 500, headers: CORS }
        );
      }

      const mentionSummaries = body.mentions.map((m, i) =>
        `${i + 1}. "${m.title}" from ${m.source} (${m.pubDate})`
      ).join('\n');

      const prompt = `You are helping categorize press/media articles about "Sunshine on a Ranney Day" (SOARD), a nonprofit charity.

For each article below, provide:
- category: one of "national-tv", "local-tv", "print", "magazine", "entertainment"
- excerpt: a 1-2 sentence summary suitable for a press page
- outletLogo: a slug version of the outlet name (lowercase, hyphens, no spaces)

Articles:
${mentionSummaries}

Respond ONLY with a JSON array of objects with fields: index, category, excerpt, outletLogo. No markdown, no backticks.`;

      const aiRes = await ai.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
      });

      let parsed = [];
      try {
        const text = (aiRes.response || '').trim();
        parsed = JSON.parse(text);
      } catch {
        // If AI response isn't valid JSON, return raw for client-side handling
        return Response.json({
          success: true,
          categorized: [],
          raw: aiRes.response || '',
        }, { headers: CORS });
      }

      return Response.json({ success: true, categorized: parsed }, { headers: CORS });
    }

    return Response.json(
      { success: false, error: 'Unknown action' },
      { status: 400, headers: CORS }
    );
  } catch (err) {
    return Response.json(
      { success: false, error: err.message },
      { status: 500, headers: CORS }
    );
  }
}

// ─── RSS Fetching & Parsing ───────────────────────────────────────

async function fetchGoogleNewsRSS(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SOARDPressMonitor/1.0)',
    },
  });

  if (!res.ok) {
    console.error(`Google News RSS failed for "${query}": ${res.status}`);
    return [];
  }

  const xml = await res.text();
  return parseRSSItems(xml, query);
}

function parseRSSItems(xml, query) {
  const items = [];
  // Match each <item>...</item> block
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const source = extractAttr(block, 'source', 'url') || extractTag(block, 'source') || '';
    const sourceName = extractTag(block, 'source') || '';
    const description = extractTag(block, 'description');

    if (title && link) {
      items.push({
        title: decodeEntities(title),
        link: cleanGoogleNewsLink(link),
        pubDate: pubDate || '',
        date: pubDate ? new Date(pubDate).toISOString().split('T')[0] : '',
        source: decodeEntities(sourceName || source),
        description: decodeEntities(stripHtml(description || '')),
        query,
      });
    }
  }

  return items;
}

// ─── Helpers ──────────────────────────────────────────────────────

function extractTag(xml, tag) {
  // Handle CDATA sections
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`);
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function extractAttr(xml, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"[^>]*>`);
  const match = xml.match(regex);
  return match ? match[1] : '';
}

function cleanGoogleNewsLink(link) {
  // Google News wraps real URLs; try to extract the actual URL
  // Format: https://news.google.com/rss/articles/... 
  // The actual URL is usually in the link directly for RSS
  return link.trim();
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Strip trailing slash, www prefix, and query params for dedup
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
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

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').trim();
}
