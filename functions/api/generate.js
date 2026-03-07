/**
 * POST /api/generate
 * Uses Claude to generate content for kid profiles.
 *
 * Expects JSON body:
 *   {
 *     type: "alt-text" | "seo" | "all",
 *     kid: { name, age, diagnosis, roomTypes, bio, photos: [{ url }], ... }
 *   }
 *
 * Returns generated fields based on type:
 *   alt-text → { altTexts: ["...", "..."] }
 *   seo → { shortDescription, metaDescription }
 *   all → { altTexts, shortDescription, metaDescription }
 *
 * Environment variables needed:
 *   ANTHROPIC_API_KEY
 */

export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const { ANTHROPIC_API_KEY } = context.env;

    if (!ANTHROPIC_API_KEY) {
      return Response.json(
        { success: false, error: 'Missing ANTHROPIC_API_KEY. Add it in Cloudflare Pages environment variables.' },
        { status: 500, headers: cors }
      );
    }

    const { type, kid } = await context.request.json();

    if (!type || !kid) {
      return Response.json(
        { success: false, error: 'Missing type or kid data' },
        { status: 400, headers: cors }
      );
    }

    const results = {};

    // ─── Generate Alt Text ─────────────────
    if (type === 'alt-text' || type === 'all') {
      const photoCount = kid.photos?.length || 0;
      if (photoCount === 0) {
        results.altTexts = [];
      } else {
        // Build content blocks with images for Claude to describe
        const content = [];
        content.push({
          type: 'text',
          text: `You are writing alt text for photos on a nonprofit website (Sunshine on a Ranney Day) that creates dream bedrooms and accessible spaces for children with special needs.

Child's name: ${kid.name}
Age: ${kid.age || 'unknown'}
Diagnosis: ${kid.diagnosis || 'not specified'}
Room types: ${(kid.roomTypes || []).join(', ') || 'not specified'}

Below are ${photoCount} photos from this child's room reveal or project. Write a concise, descriptive alt text for EACH photo — one per line, numbered 1 through ${photoCount}. Each alt text should be 10-25 words, describe what's visible in the photo, and be useful for screen readers. Do not start with "Image of" or "Photo of". Focus on the scene, people's expressions, room features, or key details.

Return ONLY the numbered list, nothing else. Example format:
1. A smiling boy sitting on his new race car bed surrounded by family members
2. Freshly painted blue bedroom walls with custom shelving and superhero decals`
        });

        // Add each photo as an image block
        for (let i = 0; i < Math.min(photoCount, 20); i++) {
          const photo = kid.photos[i];
          if (photo.url) {
            content.push({
              type: 'image',
              source: {
                type: 'url',
                url: photo.url,
              },
            });
          }
        }

        const altRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2000,
            messages: [{ role: 'user', content }],
          }),
        });

        if (!altRes.ok) {
          const err = await altRes.text();
          return Response.json(
            { success: false, error: `Anthropic API error: ${altRes.status} - ${err}` },
            { status: 500, headers: cors }
          );
        }

        const altData = await altRes.json();
        const altText = altData.content?.[0]?.text || '';

        // Parse numbered list into array
        const altTexts = altText
          .split('\n')
          .filter(line => /^\d+[\.\)]\s/.test(line.trim()))
          .map(line => line.replace(/^\d+[\.\)]\s*/, '').trim());

        // Pad with empty strings if we got fewer than expected
        while (altTexts.length < photoCount) {
          altTexts.push('');
        }

        results.altTexts = altTexts.slice(0, photoCount);
      }
    }

    // ─── Generate SEO Fields ───────────────
    if (type === 'seo' || type === 'all') {
      const seoPrompt = `You are writing SEO content for a nonprofit website (Sunshine on a Ranney Day) that creates dream bedrooms and accessible spaces for children with special needs in the greater Atlanta area.

Child's name: ${kid.name}
Age: ${kid.age || 'unknown'}
Diagnosis: ${kid.diagnosis || 'not specified'}
Room types: ${(kid.roomTypes || []).join(', ') || 'not specified'}
Bio: ${(kid.bio || '').slice(0, 500)}

Generate exactly two things:

1. SHORT_DESCRIPTION: A warm, engaging 1-2 sentence summary (50-80 words) of this child's story suitable for a card preview on the website. Focus on who the child is and what SOARD is doing for them.

2. META_DESCRIPTION: An SEO-optimized meta description (120-155 characters) for this child's page. Include the child's name, their diagnosis or situation, and "Sunshine on a Ranney Day" or "SOARD".

Return in this exact format:
SHORT_DESCRIPTION: [your text here]
META_DESCRIPTION: [your text here]`;

      const seoRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          messages: [{ role: 'user', content: seoPrompt }],
        }),
      });

      if (!seoRes.ok) {
        const err = await seoRes.text();
        return Response.json(
          { success: false, error: `Anthropic API error: ${seoRes.status} - ${err}` },
          { status: 500, headers: cors }
        );
      }

      const seoData = await seoRes.json();
      const seoText = seoData.content?.[0]?.text || '';

      const shortMatch = seoText.match(/SHORT_DESCRIPTION:\s*(.+?)(?=META_DESCRIPTION:|$)/s);
      const metaMatch = seoText.match(/META_DESCRIPTION:\s*(.+?)$/s);

      results.shortDescription = shortMatch ? shortMatch[1].trim() : '';
      results.metaDescription = metaMatch ? metaMatch[1].trim() : '';
    }

    return Response.json(
      { success: true, ...results },
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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
