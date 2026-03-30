<p align="center">
  <img src="public/favicon.svg" width="80" alt="SOARD Logo" />
</p>

<h1 align="center">Sunshine on a Ranney Day</h1>

<p align="center">
  <strong>Transforming the rooms — and lives — of children facing serious illness.</strong><br />
  501(c)(3) Nonprofit &middot; Est. 2012 &middot; Greater Atlanta, GA
</p>

<p align="center">
  <a href="https://sunshineonaranneyday.com">sunshineonaranneyday.com</a>
</p>

---

[Sunshine on a Ranney Day](https://sunshineonaranneyday.com) (SOARD) designs and builds dream bedrooms for children battling serious illness across Greater Atlanta. This repo powers the public website, a custom admin CMS, and the API layer that connects them — all running on Cloudflare's edge network.

## Architecture

```
                        Cloudflare Pages
  ┌───────────────────────────────────────────────────┐
  │                                                   │
  │   Astro SSG          Workers API      Admin CMS   │
  │   (Static Site)      (17 Endpoints)   (/admin/)   │
  │       │                  │                │       │
  └───────┼──────────────────┼────────────────┼───────┘
          │                  │                │
          ▼                  ▼                ▼
  ┌──────────────┐   ┌────────────┐   ┌────────────┐
  │  CF Images   │   │  D1        │   │  R2        │
  │  (CDN Media) │   │  (SQLite)  │   │  (Storage) │
  └──────────────┘   └─────┬──────┘   └────────────┘
                           │
                    ┌──────┴──────┐
                    │  Workers AI │
                    └─────────────┘
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Framework** | [Astro](https://astro.build) v5 | Static site generation, zero JS by default |
| **Hosting** | [Cloudflare Pages](https://pages.cloudflare.com) | Edge deployment, auto-deploy from Git |
| **Database** | [Cloudflare D1](https://developers.cloudflare.com/d1/) | Serverless SQLite for all content |
| **Media** | [Cloudflare Images](https://developers.cloudflare.com/images/) | Responsive image CDN with face-detection cropping |
| **Storage** | [Cloudflare R2](https://developers.cloudflare.com/r2/) | PDFs, financial documents, static files |
| **AI** | [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) | Content generation, alt text, SEO descriptions |
| **API** | [Cloudflare Functions](https://developers.cloudflare.com/pages/functions/) | 17 serverless endpoints for content CRUD & media |
| **Admin** | Custom CMS | OAuth-authenticated panel with Claude-powered content tooling |
| **SEO** | JSON-LD + Dynamic OG | Structured data on every page, generated OG images via Satori |
| **Font** | Outfit Variable + Libre Baskerville | Self-hosted, subset, WOFF |

## Quick Start

### Prerequisites

- Node.js 18+
- Cloudflare account with D1, R2, and Images enabled

### Setup

```bash
git clone <repo-url> && cd soard-site-main
npm install
```

Create a `.env` file:

```env
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token       # needs D1:Read permission
CLOUDFLARE_D1_ID=your-d1-database-id
```

### Run

```bash
npm run dev          # Dev server → http://localhost:4321
npm run build        # Full build: D1 sync → Astro SSG → ./dist/
npm run preview      # Serve ./dist/ locally
npm run prebuild     # Sync D1 content only (runs automatically in build)
```

## Build Pipeline

```
npm run build
  │
  ├─ 1. prebuild (scripts/prebuild.js)
  │     ├─ Fetch all content from D1 via Cloudflare REST API
  │     ├─ Write JSON files to src/content/ (kids, partners, press, etc.)
  │     ├─ Retry logic for transient D1 errors
  │     └─ Validate critical collections (abort if empty)
  │
  └─ 2. astro build
        ├─ Process .astro pages + content collections
        ├─ Generate dynamic OG images (Satori + Sharp)
        ├─ Inline all CSS, compress HTML
        ├─ Generate sitemap
        └─ Output static files → ./dist/
```

## Project Structure

```
soard-site-main/
├── src/
│   ├── content/                # Astro Content Collections (JSON)
│   │   ├── kids/               # 187 child profiles
│   │   ├── partners/           # 370+ sponsor organizations
│   │   ├── press/              # 89+ media mentions
│   │   ├── team/               # 19 team & board members
│   │   ├── events/             # Fundraisers, reveals, community events
│   │   ├── articles/           # Resource guides & articles
│   │   ├── community/          # Community impact projects
│   │   ├── site/               # Global config: settings, FAQ, story, financials
│   │   └── config.ts           # Zod schemas for all collections
│   │
│   ├── pages/                  # File-based routing
│   │   ├── index.astro         # Homepage
│   │   ├── kids/               # Kid profiles (listing + [slug] dynamic)
│   │   ├── rooms/              # Featured room projects + before/after gallery
│   │   ├── about/              # About, leadership, financials
│   │   ├── partners/           # Partner tiers (all, construction, design)
│   │   ├── resources/          # Articles (listing + [slug] dynamic)
│   │   ├── events/             # Events listing
│   │   ├── og/                 # Dynamic OG image endpoints (.png.ts)
│   │   ├── donate.astro        # Donation page
│   │   ├── apply.astro         # Family application
│   │   ├── publicity.astro     # Press kit
│   │   └── branding.astro      # Brand guidelines
│   │
│   ├── components/
│   │   ├── global/             # Header, Footer
│   │   └── ui/                 # Button, CFImage, ScrollReveal, MediaLogos
│   │
│   ├── layouts/                # BaseLayout, PageLayout
│   ├── utils/                  # cf-image, og, schema (JSON-LD), stats
│   ├── styles/                 # global.css (design tokens, resets)
│   └── fonts/                  # Outfit Variable, Libre Baskerville (WOFF)
│
├── functions/
│   └── api/                    # Cloudflare Workers API (17 endpoints)
│       ├── save-content.js     # CRUD: create/update content in D1
│       ├── read-content.js     # CRUD: fetch content from D1
│       ├── list-content.js     # CRUD: list content by collection
│       ├── delete-content.js   # CRUD: remove content from D1
│       ├── upload-image.js     # Media: upload to Cloudflare Images
│       ├── upload-video.js     # Media: upload to Cloudflare Stream
│       ├── upload-file.js      # Media: upload to R2
│       ├── generate.js         # AI: Claude-powered content generation
│       ├── press-scan.js       # Import press mentions
│       ├── cc-oauth-*.js       # Admin OAuth authentication
│       ├── newsletter*.js      # Newsletter management
│       ├── deployments.js      # Trigger CF Pages rebuilds
│       └── _middleware.js      # Auth middleware
│
├── scripts/
│   ├── prebuild.js             # D1 → src/content/ sync
│   ├── schema.sql              # D1 database schema + indexes
│   └── migrate-*.js            # Data migration utilities
│
├── public/
│   ├── admin/                  # Custom CMS admin panel
│   ├── favicon.svg             # Logo + favicon variants
│   ├── site.webmanifest        # PWA manifest
│   ├── robots.txt              # Crawl rules
│   ├── llms.txt                # LLM access policy
│   └── _redirects, _headers    # Cloudflare routing config
│
├── astro.config.mjs            # Astro: static output, sitemap, inline CSS
├── wrangler.toml               # Cloudflare: D1, R2, AI bindings
├── tsconfig.json               # TypeScript strict mode
└── package.json                # Dependencies & scripts
```

## Content Collections

All content is stored in Cloudflare D1 and synced to JSON files at build time via the prebuild step.

| Collection | Records | Description |
|-----------|---------|-------------|
| **kids** | 187 | Child profiles with bios, photos, diagnoses, room types, case studies |
| **partners** | 370+ | Sponsor organizations across four tiers |
| **press** | 89+ | Media coverage: national TV, local TV, print, magazines |
| **team** | 19 | Staff and board members |
| **events** | 4+ | Fundraisers, volunteer days, room reveals |
| **community** | 6+ | Community impact projects with metrics |
| **articles** | 3+ | Resource guides and informational content |
| **site** | — | Global settings, FAQ, story, financials, media config |

## Database

D1 schema lives in [`scripts/schema.sql`](scripts/schema.sql). Each table stores structured metadata columns (for indexing/filtering) alongside a `data` JSON column for the full record.

Key tables: `kids`, `partners`, `press`, `team`, `events`, `community`, `articles`, `site_config`, `financials`.

## API Endpoints

All endpoints run as Cloudflare Workers Functions under `/api/`. Admin endpoints are protected by OAuth middleware.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/read-content` | GET | Fetch a single content record |
| `/api/list-content` | GET | List all records in a collection |
| `/api/save-content` | POST | Create or update a record |
| `/api/delete-content` | DELETE | Remove a record |
| `/api/upload-image` | POST | Upload to Cloudflare Images |
| `/api/list-images` | GET | List images from Cloudflare Images |
| `/api/delete-image` | DELETE | Remove an image from Cloudflare Images |
| `/api/upload-video` | POST | Upload to Cloudflare Stream |
| `/api/upload-file` | POST | Upload to R2 |
| `/api/generate` | POST | AI content generation |
| `/api/press-scan` | POST | Import press mentions |
| `/api/download-logo` | POST | Download partner logos |
| `/api/deployments` | POST | Trigger site rebuild |
| `/api/newsletter` | POST | Newsletter management |
| `/api/newsletter-lists` | GET | Newsletter list configuration |
| `/api/cc-oauth-start` | GET | Initiate admin OAuth flow |
| `/api/cc-oauth-callback` | GET | Handle OAuth callback |

## Deployment

Push to `main` → Cloudflare Pages auto-builds and deploys to the edge.

The admin panel can also trigger deploys after content changes via the `/api/deployments` endpoint, which hits a CF Pages deploy hook.

### Cloudflare Bindings (wrangler.toml)

| Binding | Type | Name |
|---------|------|------|
| `DB` | D1 Database | soard-db |
| `FILES` | R2 Bucket | soard-files |
| `AI` | Workers AI | — |

### Environment Variables (CF Pages Dashboard)

| Variable | Required | Purpose |
|----------|----------|---------|
| `CF_ACCOUNT_ID` | Yes | Cloudflare Images upload |
| `CF_IMAGES_TOKEN` | Yes | Cloudflare Images API |
| `CF_PAGES_DEPLOY_HOOK` | Yes | Trigger rebuilds after content saves |
| OAuth client ID/secret | Yes | Admin panel authentication |

## Brand

| Color | Hex | PMS | Usage |
|-------|-----|-----|-------|
| Sunshine Yellow | `#FFDA24` | 116 C | Primary brand, CTAs, accents |
| SOARD Dark | `#373A36` | 447 C | Primary text, headings |
| Dark Deep | `#1A1B1F` | — | Footer, dark sections |
| Cream | `#FEFCF5` | — | Page backgrounds |
| Warm Gray | `#F5F4F0` | — | Section backgrounds, cards |
| White | `#FFFFFF` | — | Backgrounds, logo element |

| Font | Weight | Role |
|------|--------|------|
| Libre Baskerville | 700 | Display — headings, hero text |
| Outfit Variable | 400, 700 | Body — paragraphs, UI, navigation |

## Performance

- **Zero client-side JavaScript** by default (Astro static output)
- **All CSS inlined** — no render-blocking stylesheets
- **Cloudflare Images CDN** — responsive srcsets with `gravity=face`
- **Prefetch on hover** — near-instant page transitions
- **Full static generation** — served from 300+ edge locations
- **Compressed HTML** — minimal payload per page

## SEO

- **JSON-LD structured data** on every page (Organization, WebSite, WebPage, Person, FAQPage, BreadcrumbList, DonateAction)
- **Dynamic Open Graph images** generated per page via Satori + Sharp
- **Sitemap** auto-generated via `@astrojs/sitemap`
- **Semantic HTML5** throughout
- **`robots.txt`** + **`llms.txt`** for crawler/LLM access policy

---

<p align="center"><strong>EIN 45-4773997</strong> &middot; Roswell, GA 30076</p>
