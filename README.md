# Sunshine on a Ranney Day — Website

Static site built with [Astro](https://astro.build), hosted on [Cloudflare Pages](https://pages.cloudflare.com).

## Stack

- **Astro** — Static site generator (zero JS by default)
- **Cloudflare Pages** — Edge hosting, auto-deploy from Git
- **Cloudflare Images** — Responsive image optimization ($5/mo)
- **Custom AI Admin** — Content entry panel with Claude-powered content generation

## Quick Start

```bash
npm install
npm run dev        # http://localhost:4321
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server at localhost:4321 |
| `npm run build` | Build production site to `./dist/` |
| `npm run preview` | Preview production build locally |

## Deployment

Push to `main` branch → Cloudflare Pages auto-builds and deploys.

## Content

Content lives in `src/content/` as JSON files:
- `kids/` — Kid profiles
- `rooms/` — Room project details
- `partners/` — Partner info
- `financials/` — Financial documents (990s, reports)
- `site/` — Global settings and stats

## Brand Colors

| Color | Hex | Usage |
|-------|-----|-------|
| Sunshine Yellow | `#FFD500` | Primary brand, CTAs, accents |
| Purple | `#7A00DF` | Secondary accent, labels |
| Dark | `#2D2E33` | Text, dark sections |
| Cream | `#FEFCF5` | Backgrounds |

<!-- build trigger -->
