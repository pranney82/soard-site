# SOARD Admin Panel — Setup Guide

## Overview

The admin panel lives at `/admin` and provides a simple CMS for adding kids, rooms, partners, and financial documents. It uses:

- **Cloudflare Pages Functions** for secure API proxying (no API keys in the browser)
- **Anthropic Claude** for AI-generated bios, descriptions, alt text, and SEO meta
- **Cloudflare Images** for photo uploads and optimization
- **GitHub API** for committing content JSON files to the repo

## File Structure

```
functions/
  api/
    _auth-helper.js      → Shared auth token verification
    auth.js              → Passphrase login endpoint
    ai-generate.js       → Anthropic API proxy
    upload-image.js      → Cloudflare Images proxy
    github-commit.js     → GitHub API proxy (commit + read)

src/
  pages/
    admin.astro          → Astro page wrapper (loads React island)
  components/
    admin/
      AdminApp.jsx       → Full React SPA (auth, forms, publishing)
```

## Environment Variables

Set these in your **Cloudflare Pages dashboard** under:
Settings → Environment variables → Production (and Preview)

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `ADMIN_PASSPHRASE` | Passphrase for admin login | Choose any secure phrase |
| `ANTHROPIC_API_KEY` | Claude API key for AI generation | [console.anthropic.com](https://console.anthropic.com) |
| `CF_ACCOUNT_ID` | Your Cloudflare account ID | Cloudflare dashboard → Overview sidebar |
| `CF_IMAGES_TOKEN` | Cloudflare Images API token | Cloudflare dashboard → My Profile → API Tokens → Create Token with "Cloudflare Images" edit permissions |
| `GITHUB_TOKEN` | GitHub Personal Access Token | [github.com/settings/tokens](https://github.com/settings/tokens) — needs `repo` scope |
| `GITHUB_REPO` | Repository (default: `pranney82/soard`) | Optional, defaults to `pranney82/soard` |
| `GITHUB_BRANCH` | Branch to commit to (default: `main`) | Optional |

### Step-by-step: Creating the tokens

#### 1. ADMIN_PASSPHRASE
Pick something memorable for the team, e.g. `sunshine-admin-2025`. Share it with team members directly.

#### 2. ANTHROPIC_API_KEY
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. Copy the key (starts with `sk-ant-...`)

#### 3. CF_ACCOUNT_ID
1. Log in to the Cloudflare dashboard
2. Look in the right sidebar on the Overview page
3. Copy "Account ID"

#### 4. CF_IMAGES_TOKEN
1. Go to Cloudflare dashboard → My Profile → API Tokens
2. Click "Create Token"
3. Use "Custom token" template
4. Permissions: Account → Cloudflare Images → Edit
5. Create and copy the token

#### 5. GITHUB_TOKEN
1. Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)
2. Click "Generate new token" (Fine-grained)
3. Token name: `soard-admin`
4. Repository access: Select `pranney82/soard`
5. Permissions: Contents → Read and write
6. Generate and copy

## Installation

```bash
# Install dependencies (adds React to the Astro project)
npm install @astrojs/react react react-dom

# Update astro.config.mjs to include the React integration
# (see the provided astro.config.mjs)

# Run locally
npm run dev
# Visit http://localhost:4321/admin
```

> **Note:** Functions won't work with `astro dev` since they're Cloudflare Pages Functions. 
> For local testing with functions, use `npx wrangler pages dev dist` after building.

## Local Testing with Functions

```bash
# Build the Astro site
npm run build

# Run with Cloudflare Pages local dev (includes functions)
npx wrangler pages dev dist \
  --binding ADMIN_PASSPHRASE=your-passphrase \
  --binding ANTHROPIC_API_KEY=sk-ant-xxx \
  --binding CF_ACCOUNT_ID=your-account-id \
  --binding CF_IMAGES_TOKEN=your-token \
  --binding GITHUB_TOKEN=ghp_xxx
```

## How It Works

### Authentication
1. User enters passphrase at `/admin`
2. Passphrase is sent to `/api/auth` function
3. Function compares against `ADMIN_PASSPHRASE` env var
4. Returns a daily-rotating session token (SHA-256 hash)
5. Token is included in all subsequent API calls

### Adding a Kid
1. Fill in name, age, diagnosis, room type, notes
2. Upload photos (stored in browser until publish)
3. Click "Generate with AI" → calls `/api/ai-generate` → Anthropic API
4. Claude generates bio, short description, meta description, alt texts, JSON-LD
5. Review and edit the generated content
6. Click "Publish":
   - Photos upload to Cloudflare Images via `/api/upload-image`
   - JSON content file commits to GitHub via `/api/github-commit`
   - Cloudflare Pages detects the commit and rebuilds (~15 seconds)

### Adding a Room
Same flow as kids, but with before/after photo sections and room-specific AI prompts.

### Adding a Partner
No AI — just fill in details, upload logo, and publish.

### Adding a Financial Doc
Upload PDF or provide external URL, fill in metadata, publish.

## Content JSON Schema

### Kid Profile (`src/content/kids/{slug}.json`)
```json
{
  "name": "Amari",
  "age": 8,
  "diagnosis": "Cerebral palsy",
  "roomType": "bedroom",
  "slug": "amari",
  "bio": "AI-generated biography...",
  "shortDescription": "One-sentence preview",
  "metaDescription": "SEO meta under 160 chars",
  "photos": [
    { "id": "cf-image-id", "alt": "AI-generated alt text" }
  ],
  "jsonLd": { ... },
  "notes": "Internal notes",
  "createdAt": "2025-01-15T...",
  "updatedAt": "2025-01-15T..."
}
```

### Room (`src/content/rooms/{slug}.json`)
```json
{
  "kidName": "Amari",
  "roomType": "bedroom",
  "slug": "amari-bedroom",
  "description": "AI-generated description...",
  "shortDescription": "One-sentence preview",
  "metaDescription": "SEO meta",
  "featuresList": ["Custom loft bed", "Wheelchair desk"],
  "designNotes": "Space theme...",
  "partners": ["Home Depot"],
  "beforePhotos": [{ "id": "cf-id" }],
  "afterPhotos": [{ "id": "cf-id" }],
  "jsonLd": { ... },
  "createdAt": "...",
  "updatedAt": "..."
}
```

### Partner (`src/content/partners/{slug}.json`)
```json
{
  "name": "Home Depot",
  "slug": "home-depot",
  "type": "materials",
  "website": "https://homedepot.com",
  "description": "Donates materials...",
  "logo": { "id": "cf-image-id" },
  "createdAt": "...",
  "updatedAt": "..."
}
```

### Financial (`src/content/financials/{slug}.json`)
```json
{
  "title": "IRS Form 990 — FY2024",
  "slug": "990-2024",
  "type": "990",
  "year": 2024,
  "url": "https://...",
  "createdAt": "..."
}
```
