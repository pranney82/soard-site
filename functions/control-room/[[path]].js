/**
 * /control-room — the link in staff alert texts
 * ===========================================================================
 * The control room lives in the admin, behind the sign-in, so a phone asking
 * for a link preview would only get the sign-in page. This public address
 * answers link-preview fetchers (iMessage, Android Messages, Slack, …) with a
 * small page carrying a preview card, and sends everyone else straight on to
 * the control room (a plain 302, so it costs no time). Nothing here is private:
 * the card says what the link is, never what's happening.
 */

const SITE = 'https://sunshineonaranneyday.com';
export const CONTROL_ROOM = `${SITE}/admin/#broadcast/control-room`;
// Link-preview fetchers name themselves; iMessage's says facebookexternalhit and Twitterbot
const PREVIEWERS = /facebookexternalhit|Facebot|Twitterbot|Slackbot|WhatsApp|TelegramBot|Discordbot|LinkedInBot|Googlebot|bingbot|Applebot|redditbot|Pinterest|SkypeUriPreview|Iframely|Embedly/i;

const TITLE = 'SOARD reveal control room';
const DESCRIPTION = 'Sound, picture and every destination for the live reveal. Staff sign in to open it.';

export function previewPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${TITLE}</title>
<meta name="robots" content="noindex">
<meta name="description" content="${DESCRIPTION}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Sunshine on a Ranney Day">
<meta property="og:url" content="${SITE}/control-room/">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:image" content="${SITE}/og/control-room.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
</head><body><p><a href="${CONTROL_ROOM}">Open the control room</a></p></body></html>`;
}

export function onRequestGet({ request }) {
  if (!PREVIEWERS.test(request.headers.get('User-Agent') || '')) {
    return new Response(null, { status: 302, headers: { Location: CONTROL_ROOM, 'Cache-Control': 'no-store' } });
  }
  return new Response(previewPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Robots-Tag': 'noindex' } });
}
