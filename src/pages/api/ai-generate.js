// AI content generation endpoint - uses Cloudflare Workers AI
export const prerender = false;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function POST({ request, locals }) {
  const env = locals.runtime?.env;
  const ai = env?.AI;

  if (!ai) {
    return new Response(
      JSON.stringify({ error: 'Workers AI binding not configured. Add [ai] binding in wrangler.jsonc' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const { type, data } = await request.json();
    let systemPrompt, userPrompt;

    switch (type) {
      case 'kid-bio':
        systemPrompt = `You are a compassionate, warm copywriter for Sunshine on a Ranney Day (SOARD), a 501(c)(3) nonprofit that creates dream room makeovers for children with special needs in the greater Atlanta area. 

Your writing should be:
- Warm, hopeful, and dignifying — never pitying
- Focused on the child's personality, interests, and dreams
- Specific and personal, not generic
- Age-appropriate and family-friendly

Respond ONLY with valid JSON, no markdown or code fences.`;

        userPrompt = `Generate content for a kid profile with these details:
Name: ${data.name}
Age: ${data.age}
Diagnosis: ${data.diagnosis}
Room Type: ${data.roomType}
Notes: ${data.notes || 'None provided'}

Return JSON with these exact keys:
{
  "bio": "A warm 2-3 paragraph biography (150-250 words) focused on the child's personality and dreams",
  "shortDescription": "A single compelling sentence about this child for card previews",
  "metaDescription": "An SEO meta description under 160 characters for this child's profile page",
  "jsonLd": {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "A suggested page title for the child's profile",
    "description": "Same as metaDescription",
    "author": {
      "@type": "Organization",
      "name": "Sunshine on a Ranney Day"
    }
  }
}`;
        break;

      case 'kid-alt-text':
        systemPrompt = `You write descriptive, accessible alt text for photos on a nonprofit website (Sunshine on a Ranney Day). Alt text should be concise (under 125 characters), descriptive of what's visible, and never include the child's diagnosis unless visually relevant. Respond ONLY with valid JSON, no markdown or code fences.`;

        userPrompt = `Write alt text for ${data.photoCount} photo(s) of a child named ${data.name} (age ${data.age}). 
Context: ${data.context || 'Room makeover photos'}
Photo descriptions from filenames: ${data.filenames?.join(', ') || 'No filenames provided'}

Return JSON: { "altTexts": ["alt text 1", "alt text 2", ...] }
One alt text per photo, in order.`;
        break;

      case 'room-description':
        systemPrompt = `You are a warm, descriptive copywriter for Sunshine on a Ranney Day (SOARD), writing about dream room makeovers for children with special needs. Focus on the transformation, design details, and how the room serves the child's needs and personality. Respond ONLY with valid JSON, no markdown or code fences.`;

        userPrompt = `Generate content for a room makeover with these details:
Child: ${data.kidName || 'Not specified'}
Room Type: ${data.roomType}
Design Notes: ${data.designNotes || 'None provided'}
Features: ${data.features?.join(', ') || 'None listed'}
Partners Involved: ${data.partners?.join(', ') || 'None listed'}

Return JSON with these exact keys:
{
  "description": "A vivid 2-3 paragraph description of the room transformation (150-250 words)",
  "featuresList": ["Feature 1 with brief explanation", "Feature 2", ...],
  "shortDescription": "A single compelling sentence for card previews",
  "metaDescription": "SEO meta description under 160 characters",
  "jsonLd": {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "Suggested page title",
    "description": "Same as metaDescription"
  }
}`;
        break;

      default:
        return new Response(
          JSON.stringify({ error: `Unknown generation type: ${type}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

    const result = await ai.run('@cf/meta/llama-3.1-70b-instruct', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1500,
    });

    const text = result.response || '';

    let parsed;
    try {
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return new Response(
        JSON.stringify({ error: 'Failed to parse AI response', raw: text }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, generated: parsed }),
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
