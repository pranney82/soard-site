/**
 * Email Templates
 *
 * Named HTML email templates that can be sent via the /api/send-email endpoint.
 * Each template exports { from, subject, html }.
 *
 * Brand tokens (from global.css):
 *   --c-yellow: #FFDA24    --c-dark: #373A36     --c-dark-deep: #1E1F25
 *   --c-cream: #FEFCF5     --c-warm-gray: #F5F4F0  --c-text-muted: #5A5B61
 *   --c-text-light: #6D6E74  --c-border: #E5E4E0
 *   Display: Libre Baskerville   Body: Outfit
 *   Buttons: pill (100px radius)  Section labels: 28px line + 0.14em caps
 *   Highlight: italic + linear-gradient(transparent 55%, yellowSoft 55%)
 *   Hero photo: 24px radius, deep shadow, name pill overlay, yellow accent rect
 *   Quote: decorative SVG quotation mark
 */

const SITE_URL = 'https://sunshineonaranneyday.com';
const CF = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';

// ─── Brand tokens ────────────────────────────────────────────────

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

// ─── Shared helpers ──────────────────────────────────────────────

function label(text, variant = 'dark') {
  const lc = variant === 'light' ? 'rgba(255,255,255,0.35)' : variant === 'yellow' ? Y : D;
  const tc = variant === 'light' ? 'rgba(255,255,255,0.6)' : D;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
    <td style="width:28px;height:2px;background:${lc};vertical-align:middle;"></td>
    <td style="padding-left:12px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${tc};vertical-align:middle;">${text}</td>
  </tr></table>`;
}

function hl(text, v = 'light') {
  return `<em style="font-style:italic;background-image:linear-gradient(transparent 55%,${v === 'dark' ? YG : YS} 55%);background-repeat:no-repeat;background-size:100% 100%;padding:0 .1em;">${text}</em>`;
}

function pill(text, href, v = 'primary') {
  const bg = v === 'primary' ? Y : D;
  const c = v === 'primary' ? D : Y;
  return `<a href="${href}" target="_blank" style="display:inline-block;padding:16px 40px;background:${bg};color:${c};font-family:${SANS};font-size:15px;font-weight:600;text-decoration:none;border-radius:100px;letter-spacing:0.01em;">${text}</a>`;
}

// ─── Templates ───────────────────────────────────────────────────

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

// ─── Adrian 2025 ─────────────────────────────────────────────────

function adrian2025() {
  const logo = `${CF}/brand-logo-dark-bg-tagline-display/w=400,q=85`;
  const heroImg = `${CF}/kids/adrian/photo-18/w=1200,h=900,fit=cover,gravity=face,q=80`;
  const storyImg2 = `${CF}/kids/adrian/1774454540229-Adrian-SRD--33.jpg/w=500,fit=cover,q=75`;
  const storyImg3 = `${CF}/kids/adrian/1774454538805-Adrian-SRD--30.jpg/w=500,fit=cover,q=75`;
  const beforeImg = `${CF}/kids/adrian/photo-08/w=560,fit=cover,q=70`;
  const afterImg = `${CF}/kids/adrian/photo-23/w=560,fit=cover,q=70`;
  const revealImg = `${CF}/kids/adrian/photo-17/w=1100,fit=cover,gravity=face,q=80`;
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
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Outfit:wght@400;500;600;700&display=swap');
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
    img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none}
    body{margin:0;padding:0;width:100%!important;background:${WG}}
    .ec{max-width:600px;margin:0 auto}
    @media screen and (max-width:600px){
      .ec{width:100%!important}
      .fl{max-width:100%!important;height:auto!important}
      .st{display:block!important;width:100%!important;max-width:100%!important}
      .st img{width:100%!important;max-width:100%!important}
      .pd{padding-left:24px!important;padding-right:24px!important}
      .hm{display:none!important}
      .h1m{font-size:26px!important}
      .h2m{font-size:20px!important}
      .hero-img{height:300px!important;object-fit:cover!important}
      .mob-stack{padding-top:12px!important;padding-left:0!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${WG};font-family:${SANS};">

  <!-- Preheader -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Born during Hurricane Katrina at 27 weeks. Doctors said he wouldn't survive an hour. Today, Adrian has a dream room — and his mom doesn't have to hurt anymore.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>

  <center style="width:100%;background:${WG};padding:32px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" class="ec" style="margin:0 auto;">

      <!-- ═══════════════════════════════════════════
           HEADER
           ═══════════════════════════════════════════ -->
      <tr>
        <td style="background:${DD};padding:28px 48px;text-align:center;" class="pd">
          <a href="${SITE_URL}" target="_blank" style="display:inline-block;">
            <img src="${logo}" width="160" alt="Sunshine on a Ranney Day" style="width:160px;height:auto;" />
          </a>
        </td>
      </tr>

      <!-- ═══════════════════════════════════════════
           HERO — Editorial photo with overlays
           ═══════════════════════════════════════════ -->
      <tr>
        <td style="background:${CR};padding:0;position:relative;">
          <a href="${profileUrl}" target="_blank" style="display:block;text-decoration:none;">
            <!-- Photo with rounded bottom corners + shadow treatment -->
            <div style="margin:0 24px;border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.1),0 4px 16px rgba(0,0,0,0.06);">
              <img src="${heroImg}" width="552" alt="Adrian smiling in his new dream room" class="fl hero-img" style="width:100%;display:block;" />
            </div>
          </a>
        </td>
      </tr>

      <!-- Name tag pill — overlapping the photo bottom -->
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <div style="margin-top:-22px;position:relative;z-index:2;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="padding:10px 22px;background:rgba(30,31,37,0.85);border-radius:100px;font-family:${SANS};font-size:13px;font-weight:600;color:#fff;letter-spacing:0.01em;">
                  Adrian, age 19
                </td>
              </tr>
            </table>
          </div>
        </td>
      </tr>

      <!-- Detail chips -->
      <tr>
        <td style="background:${CR};padding:16px 48px 0;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td style="padding:7px 16px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TL};">
                <span style="font-weight:400;">Diagnosis</span>&nbsp;&nbsp;<strong style="color:${D};">Cerebral Palsy</strong>
              </td>
              <td width="8"></td>
              <td style="padding:7px 16px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TL};">
                <span style="font-weight:400;">Rooms</span>&nbsp;&nbsp;<strong style="color:${D};">Bathroom + Bedroom</strong>
              </td>
              <td width="8"></td>
              <td style="padding:7px 16px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TL};">
                <span style="font-weight:400;">Year</span>&nbsp;&nbsp;<strong style="color:${D};">2025</strong>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- ═══════════════════════════════════════════
           HEADLINE + LEDE
           ═══════════════════════════════════════════ -->
      <tr>
        <td style="background:${CR};padding:32px 48px 0;" class="pd">
          ${label('Project Complete')}
          <h1 class="h1m" style="margin:20px 0 0;font-family:${SERIF};font-size:34px;font-weight:700;line-height:1.18;color:${D};letter-spacing:-0.025em;">
            Meet Adrian — our little ${hl('miracle')}
          </h1>
        </td>
      </tr>

      <!-- Lede paragraph — larger, display-sized like photo essay lede -->
      <tr>
        <td style="background:${CR};padding:24px 48px 0;" class="pd">
          <p style="margin:0;font-family:${SERIF};font-size:18px;line-height:1.7;color:${D};font-weight:400;">
            Born prematurely at just 27 weeks during Hurricane Katrina, doctors said Adrian wouldn't survive an hour. He was a triplet, and heartbreakingly, his siblings passed away. Adrian fought through.
          </p>
        </td>
      </tr>

      <!-- ═══════════════════════════════════════════
           STORY — Photo essay rhythm
           ═══════════════════════════════════════════ -->

      <!-- Duo photos — side by side, like essay__duo -->
      <tr>
        <td style="background:${CR};padding:32px 48px 0;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td width="49%" class="st" valign="top">
                <img src="${storyImg2}" width="244" alt="Adrian during the design process" style="width:100%;border-radius:12px;display:block;" class="fl" />
              </td>
              <td width="2%" class="hm">&nbsp;</td>
              <td width="49%" class="st mob-stack" valign="top">
                <img src="${storyImg3}" width="244" alt="Adrian reviewing room plans" style="width:100%;border-radius:12px;display:block;" class="fl" />
              </td>
            </tr>
          </table>
          <p style="margin:8px 0 0;font-family:${SANS};font-size:11px;color:${TL};letter-spacing:0.02em;">Photos by Camen Mari</p>
        </td>
      </tr>

      <!-- Story body -->
      <tr>
        <td style="background:${CR};padding:28px 48px 0;" class="pd">
          <p style="margin:0 0 20px;font-family:${SANS};font-size:16px;line-height:1.75;color:${D};">
            Today, at 19, Adrian talks nonstop — often singing his favorite tunes from Taylor Swift, church choirs, or asking Alexa to call his grandmother in Puerto Rico. He adores zebras, trains, sushi, and Chips Ahoy cookies. His mom, a dedicated Spanish and cooking teacher, lovingly calls him her "little miracle."
          </p>
          <p style="margin:0;font-family:${SANS};font-size:16px;line-height:1.75;color:${D};">
            But daily life was a struggle. His mom could only bathe him twice a week — straddling the bathtub, lifting her 80+ lb son, balancing both their weight. No wheelchair access. No changing table. No safe way to maneuver. Adrian wanted to wash his own hands. He wanted a space that didn't cause his mommy pain.
          </p>
        </td>
      </tr>

      <!-- ═══════════════════════════════════════════
           QUOTE — Decorative quotation mark (like essay__quote)
           ═══════════════════════════════════════════ -->
      <tr>
        <td style="background:${CR};padding:40px 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${WG};border-radius:16px;">
            <tr>
              <td style="padding:36px 32px 32px;">
                <!-- Decorative quote mark -->
                <div style="margin-bottom:12px;">
                  <svg width="36" height="36" viewBox="0 0 48 48" fill="none" style="display:block;">
                    <path d="M14 28c-2.2 0-4-1.8-4-4 0-6.6 5.4-12 12-12v4c-4.4 0-8 3.6-8 8h4c2.2 0 4 1.8 4 4s-1.8 4-4 4h-4zm20 0c-2.2 0-4-1.8-4-4 0-6.6 5.4-12 12-12v4c-4.4 0-8 3.6-8 8h4c2.2 0 4 1.8 4 4s-1.8 4-4 4h-4z" fill="${Y}"/>
                  </svg>
                </div>
                <p style="margin:0;font-family:${SERIF};font-size:22px;font-style:italic;line-height:1.45;color:${D};">
                  I want a new shower so Mommy doesn&rsquo;t have to step over the side.
                </p>
                <p style="margin:16px 0 0;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TL};">
                  — Adrian
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Bold transition statement -->
      <tr>
        <td style="background:${CR};padding:0 48px;text-align:center;" class="pd">
          <p style="margin:0;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.3;color:${D};">
            That all ${hl('changed')}.
          </p>
        </td>
      </tr>

      <!-- ═══════════════════════════════════════════
           IMPACT RIBBON — Dark strip with stats
           ═══════════════════════════════════════════ -->
      <tr>
        <td style="background:${CR};padding:40px 0 0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${DD};">
            <tr>
              <td style="padding:36px 48px;" class="pd">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td width="30%" style="text-align:center;">
                      <span style="font-family:${SERIF};font-size:36px;font-weight:700;color:${Y};line-height:1;display:block;">2</span>
                      <span style="font-family:${SANS};font-size:11px;font-weight:600;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.12em;display:block;margin-top:6px;">Rooms Built</span>
                    </td>
                    <td width="5%"><div style="width:1px;height:36px;background:rgba(255,255,255,0.08);margin:0 auto;"></div></td>
                    <td width="30%" style="text-align:center;">
                      <span style="font-family:${SERIF};font-size:36px;font-weight:700;color:${Y};line-height:1;display:block;">19</span>
                      <span style="font-family:${SANS};font-size:11px;font-weight:600;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.12em;display:block;margin-top:6px;">Partners</span>
                    </td>
                    <td width="5%"><div style="width:1px;height:36px;background:rgba(255,255,255,0.08);margin:0 auto;"></div></td>
                    <td width="30%" style="text-align:center;">
                      <span style="font-family:${SERIF};font-size:36px;font-weight:700;color:${Y};line-height:1;display:block;">1</span>
                      <span style="font-family:${SANS};font-size:11px;font-weight:600;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.12em;display:block;margin-top:6px;">Miracle</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- ═══════════════════════════════════════════
           WHAT WE BUILT
           ═══════════════════════════════════════════ -->
      <tr>
        <td style="background:${CR};padding:44px 48px 0;" class="pd">
          ${label('What We Built', 'yellow')}
          <h2 class="h2m" style="margin:20px 0 8px;font-family:${SERIF};font-size:26px;font-weight:700;line-height:1.25;color:${D};letter-spacing:-0.01em;">
            Two rooms, one ${hl('purpose')}
          </h2>
          <p style="margin:0 0 28px;font-family:${SANS};font-size:15px;line-height:1.7;color:${TM};">
            Safety, independence, and joy — at the center of every decision.
          </p>
        </td>
      </tr>

      <!-- Room 01 -->
      <tr>
        <td style="background:${CR};padding:0 48px 12px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="padding:24px;background:${WG};border-radius:12px;">
                <span style="font-family:${SERIF};font-size:26px;font-weight:700;color:${BD};line-height:1;display:block;margin-bottom:6px;">01</span>
                <p style="margin:0 0 6px;font-family:${SANS};font-size:16px;font-weight:700;color:${D};">Accessible Bathroom</p>
                <div style="width:32px;height:2px;background:${Y};margin-bottom:14px;"></div>
                <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.7;color:${TM};">
                  Roll-in shower with central showerhead, wheelchair-accessible sink so Adrian can wash his own hands, ample storage shared with his sister, and a completely reimagined layout by Jennifer Crosby of Crosby Design Group.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Room 02 -->
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="padding:24px;background:${WG};border-radius:12px;">
                <span style="font-family:${SERIF};font-size:26px;font-weight:700;color:${BD};line-height:1;display:block;margin-bottom:6px;">02</span>
                <p style="margin:0 0 6px;font-family:${SANS};font-size:16px;font-weight:700;color:${D};">Dream Bedroom</p>
                <div style="width:32px;height:2px;background:${Y};margin-bottom:14px;"></div>
                <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.7;color:${TM};">
                  A one-of-a-kind bed designed to look like a shoebox, built-in closet and desk by Echols Glass &amp; Mirror, safety rails by Therapy Gyms, and a stair lift from 101 Mobility so Adrian stays on the same floor as his family.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- ═══════════════════════════════════════════
           THE TRANSFORMATION — Before/After + Reveal
           ═══════════════════════════════════════════ -->
      <tr>
        <td style="background:${CR};padding:40px 48px 0;" class="pd">
          ${label('The Transformation')}
          <h2 class="h2m" style="margin:20px 0 24px;font-family:${SERIF};font-size:26px;font-weight:700;line-height:1.25;color:${D};">
            From struggle to ${hl('sunshine')}
          </h2>
        </td>
      </tr>

      <!-- Before / After -->
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td width="49%" class="st" valign="top">
                <p style="margin:0 0 8px;font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:${TL};">Before</p>
                <img src="${beforeImg}" width="244" alt="Adrian's bathroom before renovation" style="width:100%;border-radius:12px;display:block;" class="fl">
              </td>
              <td width="2%" class="hm">&nbsp;</td>
              <td width="49%" class="st mob-stack" valign="top">
                <p style="margin:0 0 8px;font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:${TL};">After</p>
                <img src="${afterImg}" width="244" alt="Adrian's new accessible bathroom" style="width:100%;border-radius:12px;display:block;" class="fl">
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Cinematic reveal photo — full width, like essay__cinematic -->
      <tr>
        <td style="background:${CR};padding:28px 24px 0;">
          <div style="border-radius:16px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.1);">
            <img src="${revealImg}" width="552" alt="Adrian seeing his new room for the first time — the big reveal" style="width:100%;display:block;" class="fl" />
          </div>
          <p style="margin:10px 0 0;text-align:center;font-family:${SANS};font-size:12px;color:${TL};letter-spacing:0.02em;font-style:italic;">The big reveal — the moment everything changed</p>
        </td>
      </tr>

      <!-- Primary CTA -->
      <tr>
        <td style="background:${CR};padding:40px 48px 0;text-align:center;" class="pd">
          ${pill("See Adrian's Full Story &rarr;", profileUrl)}
        </td>
      </tr>

      <!-- ═══════════════════════════════════════════
           PARTNERS — Dark editorial section
           ═══════════════════════════════════════════ -->
      <tr>
        <td style="background:${CR};padding:48px 0 0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${DD};">
            <tr>
              <td style="padding:44px 48px;" class="pd">
                ${label('Our Partners', 'light')}
                <h2 class="h2m" style="margin:20px 0 12px;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.3;color:#fff;">
                  Made possible by ${hl('incredible', 'dark')} partners
                </h2>
                <p style="margin:0 0 24px;font-family:${SANS};font-size:15px;line-height:1.7;color:rgba(255,255,255,0.6);">
                  This project wouldn't exist without the generosity of partners who show up, project after project, with heart and hands ready to build.
                </p>
                <p style="margin:0;font-family:${SANS};font-size:13px;line-height:2.2;color:rgba(255,255,255,0.35);">
                  Spirit of Life Walkathon &middot; WYP Construction &middot; Pella &middot; Roswell Women's Club &middot; Jimmy &amp; Helen Carlos &middot; Kids R Kids Foundation &middot; Real Floors Commercial &middot; Randall Brothers &middot; MSI &middot; Top Knobs &middot; Pulley &amp; Associates &middot; Sherwin Williams &middot; TKO Plumbing &middot; ServiceWise Electric &middot; Carmen Mari Photography &middot; Jim Van Epps &middot; Lee Hainer &middot; Fine Lines Environments &middot; Firefly Forts
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- ═══════════════════════════════════════════
           IMPACT TIERS — From donate page
           ═══════════════════════════════════════════ -->
      <tr>
        <td style="background:${CR};padding:48px 48px 0;" class="pd">
          ${label('Your Impact', 'yellow')}
          <h2 class="h2m" style="margin:20px 0 8px;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.25;color:${D};">
            Every dollar has a ${hl('purpose')}
          </h2>
          <p style="margin:0 0 28px;font-family:${SANS};font-size:15px;line-height:1.7;color:${TM};">
            Families are on our waitlist right now. Your gift brings us closer to saying ${hl('yes')} to the next child.
          </p>
        </td>
      </tr>

      <!-- Featured tier: $500 -->
      <tr>
        <td style="background:${CR};padding:0 48px 12px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="padding:28px;background:${D};border-radius:12px;text-align:center;">
                <span style="display:inline-block;padding:5px 14px;background:${Y};border-radius:100px;font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${D};margin-bottom:14px;">Most Popular</span>
                <p style="margin:0 0 4px;font-family:${SERIF};font-size:34px;font-weight:700;color:#fff;">$500</p>
                <p style="margin:0 0 8px;font-family:${SANS};font-size:14px;font-weight:600;color:${Y};">Furniture &amp; Flooring</p>
                <p style="margin:0 0 22px;font-family:${SANS};font-size:13px;line-height:1.6;color:rgba(255,255,255,0.55);">Adaptive furniture or accessible flooring — the structural pieces that change a child's daily life.</p>
                ${pill('Give $500 &rarr;', zeffy500)}
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Smaller tiers: $60 + $125 side by side -->
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td width="49%" class="st" valign="top">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
                  <td style="padding:22px;background:${WG};border-radius:12px;text-align:center;">
                    <p style="margin:0 0 2px;font-family:${SERIF};font-size:26px;font-weight:700;color:${D};">$60</p>
                    <p style="margin:0 0 8px;font-family:${SANS};font-size:13px;font-weight:600;color:${TM};">Paint &amp; Supplies</p>
                    <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;line-height:1.6;color:${TL};">Transforms walls into a child's dream canvas.</p>
                    <a href="${zeffy60}" target="_blank" style="font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">Give $60 &rarr;</a>
                  </td>
                </tr></table>
              </td>
              <td width="2%" class="hm">&nbsp;</td>
              <td width="49%" class="st mob-stack" valign="top">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
                  <td style="padding:22px;background:${WG};border-radius:12px;text-align:center;">
                    <p style="margin:0 0 2px;font-family:${SERIF};font-size:26px;font-weight:700;color:${D};">$125</p>
                    <p style="margin:0 0 8px;font-family:${SANS};font-size:13px;font-weight:600;color:${TM};">Bedding &amp; Decor</p>
                    <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;line-height:1.6;color:${TL};">The details that make a room feel like home.</p>
                    <a href="${zeffy125}" target="_blank" style="font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">Give $125 &rarr;</a>
                  </td>
                </tr></table>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Trust signals -->
      <tr>
        <td style="background:${CR};padding:24px 48px 0;text-align:center;" class="pd">
          <p style="margin:0;font-family:${SANS};font-size:12px;color:${TL};">
            <!-- Inline SVG shield icon -->
            <span style="vertical-align:middle;display:inline-block;margin-right:4px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="vertical-align:middle;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" stroke="${TL}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="m9 12 2 2 4-4" stroke="${TL}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
            Tax-Deductible
            <span style="padding:0 10px;color:${BD};">&middot;</span>
            Zero Platform Fees
            <span style="padding:0 10px;color:${BD};">&middot;</span>
            501(c)(3)
          </p>
        </td>
      </tr>

      <!-- ═══════════════════════════════════════════
           FOUNDER NOTE
           ═══════════════════════════════════════════ -->
      <tr>
        <td style="background:${CR};padding:40px 48px 0;" class="pd">
          <div style="height:1px;background:${BD};margin-bottom:36px;"></div>
          <p style="margin:0 0 20px;font-family:${SERIF};font-size:17px;font-style:italic;line-height:1.7;color:${D};">
            Adrian reminded us why we started SOARD. When he told us he wanted a new shower so his mommy wouldn't hurt anymore — that's the moment. That's why we do this. Every room we build is a promise that these kids and their families aren't alone.
          </p>
          <p style="margin:0 0 2px;font-family:${SANS};font-size:14px;font-weight:700;color:${D};">Peter &amp; Holly Ranney</p>
          <p style="margin:0;font-family:${SANS};font-size:13px;color:${TM};">Founders, Sunshine on a Ranney Day</p>
        </td>
      </tr>

      <!-- Final CTA -->
      <tr>
        <td style="background:${CR};padding:40px 48px 48px;text-align:center;" class="pd">
          ${pill('Donate Now &rarr;', donateUrl, 'dark')}
        </td>
      </tr>

      <!-- ═══════════════════════════════════════════
           FOOTER
           ═══════════════════════════════════════════ -->
      <tr>
        <td style="background:${DD};padding:36px 48px;text-align:center;" class="pd">
          <a href="${SITE_URL}" target="_blank" style="display:inline-block;margin-bottom:16px;">
            <img src="${logo}" width="120" alt="Sunshine on a Ranney Day" style="width:120px;height:auto;" />
          </a>
          <p style="margin:0 0 8px;font-family:${SANS};font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;">
            250 Hembree Park Drive, Suite 106 &middot; Roswell, GA 30076
          </p>
          <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;color:rgba(255,255,255,0.3);">
            501(c)(3) Nonprofit &middot; EIN 45-4773997
          </p>
          <p style="margin:0 0 20px;font-family:${SANS};font-size:13px;">
            <a href="https://www.facebook.com/sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.45);text-decoration:underline;text-underline-offset:3px;">Facebook</a>
            <span style="color:rgba(255,255,255,0.15);padding:0 8px;">&middot;</span>
            <a href="https://www.instagram.com/sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.45);text-decoration:underline;text-underline-offset:3px;">Instagram</a>
            <span style="color:rgba(255,255,255,0.15);padding:0 8px;">&middot;</span>
            <a href="https://www.youtube.com/@sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.45);text-decoration:underline;text-underline-offset:3px;">YouTube</a>
            <span style="color:rgba(255,255,255,0.15);padding:0 8px;">&middot;</span>
            <a href="https://www.tiktok.com/@sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.45);text-decoration:underline;text-underline-offset:3px;">TikTok</a>
          </p>
          <p style="margin:0 0 8px;font-family:${SANS};font-size:11px;color:rgba(255,255,255,0.2);">
            You're receiving this because you're a valued partner or supporter of SOARD.
          </p>
          <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="font-family:${SANS};font-size:11px;color:rgba(255,255,255,0.3);text-decoration:underline;text-underline-offset:2px;">Unsubscribe</a>
        </td>
      </tr>

    </table>
  </center>
</body>
</html>`;
}
