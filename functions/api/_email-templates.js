/**
 * Email Templates
 *
 * Named HTML email templates that can be sent via the /api/send-email endpoint.
 * Each template exports { from, subject, html }.
 *
 * Brand tokens (from global.css):
 *   --c-yellow: #FFDA24    --c-dark: #373A36     --c-dark-deep: #1E1F25
 *   --c-cream: #FEFCF5     --c-warm-gray: #F5F4F0  --c-text-muted: #5A5B61
 *   --c-border: #E5E4E0
 *   Display font: Libre Baskerville, Georgia, serif
 *   Body font: Outfit, -apple-system, sans-serif
 *   Buttons: pill shape (border-radius: 100px)
 *   Section labels: uppercase, 12px, 0.14em tracking, 28px line before
 *   Highlight: italic + linear-gradient(transparent 55%, yellowSoft 55%)
 */

const SITE_URL = 'https://sunshineonaranneyday.com';
const CF = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';

// ─── Shared brand constants ──────────────────────────────────────

const Y = '#FFDA24';
const YS = 'rgba(255,218,36,0.45)';
const YG = 'rgba(255,218,36,0.3)';
const D = '#373A36';
const DD = '#1E1F25';
const CR = '#FEFCF5';
const WG = '#F5F4F0';
const TM = '#5A5B61';
const TL = '#6D6E74';
const BD = '#E5E4E0';

const SERIF = "'Libre Baskerville',Georgia,'Times New Roman',serif";
const SANS = "'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

const templates = {
  'adrian-2025': {
    from: 'Sunshine on a Ranney Day <sunshine@comms.soardcharity.com>',
    subject: "Adrian's Dream Room is Complete — See the Transformation",
    html: adrian2025(),
  },
};

export function getEmailTemplate(name) {
  return templates[name] || null;
}

/** Section label — 28px line + uppercase text */
function sectionLabel(text, variant = 'dark') {
  const lineColor = variant === 'light' ? 'rgba(255,255,255,0.4)' : variant === 'yellow' ? Y : D;
  const textColor = variant === 'light' ? 'rgba(255,255,255,0.7)' : D;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td style="width:28px;height:2px;background:${lineColor};vertical-align:middle;"></td>
      <td style="padding-left:12px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${textColor};vertical-align:middle;">${text}</td>
    </tr>
  </table>`;
}

/** Yellow highlight text */
function hl(text, variant = 'light') {
  const bg = variant === 'dark' ? YG : YS;
  return `<em style="font-style:italic;background-image:linear-gradient(transparent 55%,${bg} 55%);background-repeat:no-repeat;background-size:100% 100%;padding:0 0.1em;">${text}</em>`;
}

/** Pill button */
function btn(text, href, variant = 'primary') {
  const bg = variant === 'primary' ? Y : D;
  const color = variant === 'primary' ? D : Y;
  return `<a href="${href}" target="_blank" style="display:inline-block;padding:16px 40px;background:${bg};color:${color};font-family:${SANS};font-size:15px;font-weight:600;text-decoration:none;border-radius:100px;letter-spacing:0.01em;mso-padding-alt:0;text-align:center;">
    <!--[if mso]><i style="mso-font-width:150%;mso-text-raise:30px">&nbsp;</i><![endif]-->
    <span style="mso-text-raise:15px;">${text}</span>
    <!--[if mso]><i style="mso-font-width:150%;">&nbsp;</i><![endif]-->
  </a>`;
}

// ─── Adrian 2025 ─────────────────────────────────────────────────

function adrian2025() {
  const logo = `${CF}/brand-logo-dark-bg-tagline-display/w=400,q=85`;
  const heroImg = `${CF}/kids/adrian/photo-18/w=1200,fit=cover,gravity=face,q=75`;
  const storyImg = `${CF}/kids/adrian/photo-19/w=1000,fit=cover,gravity=face,q=75`;
  const beforeImg = `${CF}/kids/adrian/photo-08/w=560,fit=cover,q=70`;
  const afterImg = `${CF}/kids/adrian/photo-23/w=560,fit=cover,q=70`;
  const revealImg = `${CF}/kids/adrian/photo-17/w=1000,fit=cover,q=75`;
  const profileUrl = `${SITE_URL}/kids/adrian-2025`;
  const donateUrl = `${SITE_URL}/donate`;
  const zeffy500 = 'https://www.zeffy.com/en-US/donation-form/help-build-a-brighter-home?amount=500';
  const zeffy125 = 'https://www.zeffy.com/en-US/donation-form/help-build-a-brighter-home?amount=125';
  const zeffy60 = 'https://www.zeffy.com/en-US/donation-form/help-build-a-brighter-home?amount=60';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Adrian's Dream Room is Complete</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Outfit:wght@400;500;600;700&display=swap');
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
    img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none}
    body{margin:0;padding:0;width:100%!important;background:${WG}}
    .email-container{max-width:600px;margin:0 auto}
    @media screen and (max-width:600px){
      .email-container{width:100%!important}
      .fluid{max-width:100%!important;height:auto!important}
      .stack{display:block!important;width:100%!important;max-width:100%!important}
      .stack img{width:100%!important;max-width:100%!important}
      .pad{padding-left:24px!important;padding-right:24px!important}
      .hide-m{display:none!important}
      .h1-m{font-size:26px!important}
      .hero-img-m{height:320px!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${WG};font-family:${SANS};">

  <!-- Preheader -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Born during Hurricane Katrina at 27 weeks, told he wouldn't survive an hour — Adrian now has a dream room that changes everything.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>

  <center style="width:100%;background:${WG};padding:24px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" class="email-container" style="margin:0 auto;">

      <!-- ═══ HEADER ═══ -->
      <tr>
        <td style="background:${DD};padding:28px 48px;text-align:center;" class="pad">
          <img src="${logo}" width="160" alt="Sunshine on a Ranney Day" style="width:160px;height:auto;" />
        </td>
      </tr>

      <!-- ═══ HERO — Editorial asymmetric treatment ═══ -->
      <tr>
        <td style="background:${CR};padding:0;">
          <!-- Hero photo with overlaid detail chips -->
          <div style="position:relative;">
            <a href="${profileUrl}" target="_blank" style="display:block;">
              <img src="${heroImg}" width="600" height="400" alt="Adrian smiling in his new dream room" style="width:100%;height:auto;display:block;object-fit:cover;" class="fluid hero-img-m" />
            </a>
          </div>
        </td>
      </tr>

      <!-- Detail chips — like kid profile hero -->
      <tr>
        <td style="background:${CR};padding:20px 48px 0;" class="pad">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td style="padding:6px 14px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TM};margin-right:8px;">
                <span style="font-weight:400;">Age</span>&nbsp;&nbsp;<strong style="color:${D};">19</strong>
              </td>
              <td width="8"></td>
              <td style="padding:6px 14px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TM};">
                <span style="font-weight:400;">Diagnosis</span>&nbsp;&nbsp;<strong style="color:${D};">Cerebral Palsy</strong>
              </td>
              <td width="8"></td>
              <td style="padding:6px 14px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TM};">
                <span style="font-weight:400;">Rooms</span>&nbsp;&nbsp;<strong style="color:${D};">2</strong>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- ═══ HEADLINE ═══ -->
      <tr>
        <td style="background:${CR};padding:28px 48px 0;" class="pad">
          ${sectionLabel('Project Complete &middot; 2025')}
          <h1 class="h1-m" style="margin:20px 0 0;font-family:${SERIF};font-size:32px;font-weight:700;line-height:1.2;color:${D};letter-spacing:-0.02em;">
            Meet Adrian — our little ${hl('miracle')}
          </h1>
        </td>
      </tr>

      <!-- ═══ STORY — Part 1 ═══ -->
      <tr>
        <td style="background:${CR};padding:24px 48px 0;" class="pad">
          <p style="margin:0 0 20px;font-family:${SANS};font-size:16px;line-height:1.75;color:${D};">
            Born prematurely at just 27 weeks during Hurricane Katrina, doctors said Adrian wouldn't survive an hour. He was a triplet, and heartbreakingly, his siblings passed away. Adrian fought through — and today, at 19, he talks nonstop, sings Taylor Swift, and calls his grandmother in Puerto Rico through Alexa.
          </p>
        </td>
      </tr>

      <!-- ═══ EDITORIAL PHOTO BREAK — Cinematic inline ═══ -->
      <tr>
        <td style="background:${CR};padding:8px 48px 8px;" class="pad">
          <img src="${storyImg}" width="504" alt="Adrian with his mom during the design process" style="width:100%;height:auto;display:block;border-radius:8px;" class="fluid" />
          <p style="margin:8px 0 0;font-family:${SANS};font-size:11px;color:${TL};letter-spacing:0.02em;">Photo by Camen Mari</p>
        </td>
      </tr>

      <!-- ═══ STORY — Part 2 ═══ -->
      <tr>
        <td style="background:${CR};padding:20px 48px 0;" class="pad">
          <p style="margin:0 0 20px;font-family:${SANS};font-size:16px;line-height:1.75;color:${D};">
            Adrian lives with Cerebral Palsy and requires total physical care. His mom could only bathe him twice a week because of how dangerous the old bathroom was — straddling the bathtub, lifting her 80+ lb son, balancing both their weight. There was no wheelchair access, no changing table, no safe way to maneuver.
          </p>
          <p style="margin:0;font-family:${SERIF};font-size:20px;line-height:1.4;color:${D};font-weight:700;">
            That all changed.
          </p>
        </td>
      </tr>

      <!-- ═══ QUOTE ═══ -->
      <tr>
        <td style="background:${CR};padding:36px 48px;" class="pad">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="border-left:4px solid ${Y};padding:24px 28px;background:${WG};">
                <p style="margin:0;font-family:${SERIF};font-size:22px;font-style:italic;line-height:1.45;color:${D};">
                  &ldquo;I want a new shower so Mommy doesn&rsquo;t have to step over the side.&rdquo;
                </p>
                <p style="margin:14px 0 0;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TM};">
                  — Adrian
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- ═══ WHAT WE BUILT ═══ -->
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pad">
          ${sectionLabel('What We Built', 'yellow')}
          <h2 style="margin:20px 0 8px;font-family:${SERIF};font-size:26px;font-weight:700;line-height:1.25;color:${D};letter-spacing:-0.01em;">
            Two rooms, one ${hl('purpose')}
          </h2>
          <p style="margin:0 0 28px;font-family:${SANS};font-size:15px;line-height:1.7;color:${TM};">
            Safety, independence, and joy — at the center of every decision.
          </p>
        </td>
      </tr>

      <!-- Room 01 -->
      <tr>
        <td style="background:${CR};padding:0 48px 12px;" class="pad">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="padding:24px;background:${WG};border-radius:8px;">
                <span style="font-family:${SERIF};font-size:24px;font-weight:700;color:${BD};line-height:1;display:block;margin-bottom:6px;">01</span>
                <p style="margin:0 0 6px;font-family:${SANS};font-size:16px;font-weight:700;color:${D};">Accessible Bathroom</p>
                <div style="width:32px;height:2px;background:${Y};margin-bottom:12px;"></div>
                <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.65;color:${TM};">
                  Roll-in shower with central showerhead, wheelchair-accessible sink so Adrian can wash his own hands, ample storage shared with his sister, and a completely reimagined layout by Jennifer Crosby of Crosby Design Group.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Room 02 -->
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pad">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="padding:24px;background:${WG};border-radius:8px;">
                <span style="font-family:${SERIF};font-size:24px;font-weight:700;color:${BD};line-height:1;display:block;margin-bottom:6px;">02</span>
                <p style="margin:0 0 6px;font-family:${SANS};font-size:16px;font-weight:700;color:${D};">Dream Bedroom</p>
                <div style="width:32px;height:2px;background:${Y};margin-bottom:12px;"></div>
                <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.65;color:${TM};">
                  A one-of-a-kind bed designed to look like a shoebox, built-in closet and desk by Echols Glass &amp; Mirror, safety rails by Therapy Gyms, and a stair lift from 101 Mobility so Adrian stays on the same floor as his family.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- ═══ BEFORE / AFTER — Full-width dramatic ═══ -->
      <tr>
        <td style="background:${CR};padding:36px 48px 0;" class="pad">
          ${sectionLabel('The Transformation')}
        </td>
      </tr>
      <tr>
        <td style="background:${CR};padding:16px 48px 0;" class="pad">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td width="48%" class="stack" valign="top">
                <p style="margin:0 0 8px;font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:${TL};">Before</p>
                <img src="${beforeImg}" width="240" alt="Adrian's bathroom before renovation" style="width:100%;border-radius:8px;display:block;" class="fluid">
              </td>
              <td width="4%" class="hide-m" style="font-size:0;">&nbsp;</td>
              <td width="48%" class="stack" valign="top">
                <p style="margin:0 0 8px;font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:${TL};">After</p>
                <img src="${afterImg}" width="240" alt="Adrian's beautiful new accessible bathroom" style="width:100%;border-radius:8px;display:block;" class="fluid">
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- ═══ REVEAL PHOTO — Cinematic moment ═══ -->
      <tr>
        <td style="background:${CR};padding:32px 48px 0;" class="pad">
          <img src="${revealImg}" width="504" alt="Adrian seeing his new room for the first time" style="width:100%;height:auto;display:block;border-radius:8px;" class="fluid" />
          <p style="margin:8px 0 0;font-family:${SANS};font-size:11px;color:${TL};letter-spacing:0.02em;">The big reveal — the moment everything changed</p>
        </td>
      </tr>

      <!-- ═══ PRIMARY CTA ═══ -->
      <tr>
        <td style="background:${CR};padding:40px 48px 48px;text-align:center;" class="pad">
          ${btn("See Adrian's Full Story &rarr;", profileUrl, 'primary')}
        </td>
      </tr>

      <!-- ═══ PARTNERS — Dark section ═══ -->
      <tr>
        <td style="background:${DD};padding:44px 48px;" class="pad">
          ${sectionLabel('Our Partners', 'light')}
          <h2 style="margin:20px 0 12px;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.3;color:#fff;">
            Made possible by ${hl('incredible', 'dark')} partners
          </h2>
          <p style="margin:0 0 24px;font-family:${SANS};font-size:15px;line-height:1.7;color:rgba(255,255,255,0.65);">
            This project wouldn't exist without the generosity of partners who show up, project after project, with heart and hands ready to build.
          </p>
          <p style="margin:0;font-family:${SANS};font-size:13px;line-height:2.1;color:rgba(255,255,255,0.4);">
            Spirit of Life Walkathon &middot; WYP Construction &middot; Pella &middot; Roswell Women's Club &middot; Jimmy &amp; Helen Carlos &middot; Kids R Kids Foundation &middot; Real Floors Commercial &middot; Randall Brothers &middot; MSI &middot; Top Knobs &middot; Pulley &amp; Associates &middot; Sherwin Williams &middot; TKO Plumbing &middot; ServiceWise Electric &middot; Carmen Mari Photography &middot; Jim Van Epps &middot; Lee Hainer &middot; Fine Lines Environments &middot; Firefly Forts
          </p>
        </td>
      </tr>

      <!-- ═══ IMPACT TIERS — From donate page ═══ -->
      <tr>
        <td style="background:${CR};padding:44px 48px 0;" class="pad">
          ${sectionLabel('Your Impact', 'yellow')}
          <h2 style="margin:20px 0 8px;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.25;color:${D};">
            Every dollar has a ${hl('purpose')}
          </h2>
          <p style="margin:0 0 28px;font-family:${SANS};font-size:15px;line-height:1.7;color:${TM};">
            Families are on our waitlist right now, hoping for a room makeover. Your gift brings us closer to saying <em style="font-style:italic;">yes</em> to the next child.
          </p>
        </td>
      </tr>

      <!-- Tier: $500 (featured) -->
      <tr>
        <td style="background:${CR};padding:0 48px 12px;" class="pad">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="padding:24px;background:${D};border-radius:8px;text-align:center;">
                <span style="display:inline-block;padding:4px 12px;background:${Y};border-radius:100px;font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${D};margin-bottom:12px;">Most Popular</span>
                <p style="margin:0 0 4px;font-family:${SERIF};font-size:32px;font-weight:700;color:#fff;">$500</p>
                <p style="margin:0 0 8px;font-family:${SANS};font-size:14px;font-weight:600;color:${Y};">Furniture &amp; Flooring</p>
                <p style="margin:0 0 20px;font-family:${SANS};font-size:13px;line-height:1.6;color:rgba(255,255,255,0.6);">Adaptive furniture or new accessible flooring — the structural pieces that change a child's daily life.</p>
                ${btn('Give $500 &rarr;', zeffy500, 'primary')}
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Tier row: $60 + $125 -->
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pad">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td width="48%" class="stack" valign="top">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td style="padding:20px;background:${WG};border-radius:8px;text-align:center;">
                      <p style="margin:0 0 2px;font-family:${SERIF};font-size:24px;font-weight:700;color:${D};">$60</p>
                      <p style="margin:0 0 8px;font-family:${SANS};font-size:13px;font-weight:600;color:${TM};">Paint &amp; Supplies</p>
                      <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;line-height:1.55;color:${TL};">Transforms walls into a child's dream canvas.</p>
                      <a href="${zeffy60}" target="_blank" style="font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">Give $60 &rarr;</a>
                    </td>
                  </tr>
                </table>
              </td>
              <td width="4%" class="hide-m">&nbsp;</td>
              <td width="48%" class="stack" valign="top">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td style="padding:20px;background:${WG};border-radius:8px;text-align:center;">
                      <p style="margin:0 0 2px;font-family:${SERIF};font-size:24px;font-weight:700;color:${D};">$125</p>
                      <p style="margin:0 0 8px;font-family:${SANS};font-size:13px;font-weight:600;color:${TM};">Bedding &amp; Decor</p>
                      <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;line-height:1.55;color:${TL};">The details that make a room feel like home.</p>
                      <a href="${zeffy125}" target="_blank" style="font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">Give $125 &rarr;</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- ═══ FOUNDER NOTE ═══ -->
      <tr>
        <td style="background:${CR};padding:44px 48px 0;" class="pad">
          <div style="height:1px;background:${BD};margin-bottom:36px;"></div>
          <p style="margin:0 0 16px;font-family:${SERIF};font-size:18px;font-style:italic;line-height:1.65;color:${D};">
            Adrian reminded us why we started SOARD. When he told us he wanted a new shower so his mommy wouldn't hurt anymore — that's the moment. That's why we do this. Every room we build is a promise that these kids and their families aren't alone.
          </p>
          <p style="margin:0 0 4px;font-family:${SANS};font-size:14px;font-weight:700;color:${D};">Peter &amp; Holly Ranney</p>
          <p style="margin:0;font-family:${SANS};font-size:13px;color:${TM};">Founders, Sunshine on a Ranney Day</p>
        </td>
      </tr>

      <!-- ═══ FINAL CTA ═══ -->
      <tr>
        <td style="background:${CR};padding:40px 48px 48px;text-align:center;" class="pad">
          ${btn('Donate Now &rarr;', donateUrl, 'dark')}
        </td>
      </tr>

      <!-- ═══ FOOTER ═══ -->
      <tr>
        <td style="background:${DD};padding:32px 48px;text-align:center;" class="pad">
          <img src="${logo}" width="120" alt="Sunshine on a Ranney Day" style="width:120px;height:auto;margin-bottom:16px;" />
          <p style="margin:0 0 8px;font-family:${SANS};font-size:13px;color:rgba(255,255,255,0.5);line-height:1.6;">
            250 Hembree Park Drive, Suite 106 &middot; Roswell, GA 30076
          </p>
          <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;color:rgba(255,255,255,0.35);">
            501(c)(3) Nonprofit &middot; EIN 45-4773997
          </p>
          <p style="margin:0 0 20px;font-family:${SANS};font-size:13px;">
            <a href="https://www.facebook.com/sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.5);text-decoration:underline;text-underline-offset:3px;">Facebook</a>
            <span style="color:rgba(255,255,255,0.2);padding:0 8px;">&middot;</span>
            <a href="https://www.instagram.com/sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.5);text-decoration:underline;text-underline-offset:3px;">Instagram</a>
            <span style="color:rgba(255,255,255,0.2);padding:0 8px;">&middot;</span>
            <a href="https://www.youtube.com/@sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.5);text-decoration:underline;text-underline-offset:3px;">YouTube</a>
            <span style="color:rgba(255,255,255,0.2);padding:0 8px;">&middot;</span>
            <a href="https://www.tiktok.com/@sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.5);text-decoration:underline;text-underline-offset:3px;">TikTok</a>
          </p>
          <p style="margin:0 0 12px;font-family:${SANS};font-size:11px;color:rgba(255,255,255,0.25);">
            You're receiving this because you're a valued partner or supporter of SOARD.
          </p>
          <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="font-family:${SANS};font-size:11px;color:rgba(255,255,255,0.35);text-decoration:underline;text-underline-offset:2px;">Unsubscribe</a>
        </td>
      </tr>

    </table>
  </center>
</body>
</html>`;
}
