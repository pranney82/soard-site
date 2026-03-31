# SOARD Press Monitor

Automated Cloudflare Worker that scans for new media mentions of Sunshine on a Ranney Day and emails you when new articles are found.

## How It Works

- Runs automatically on the **1st and 15th** of every month at 10am ET
- Searches Google News RSS for SOARD-related queries
- Compares results against your existing press articles (pulled from GitHub)
- Tracks all seen URLs in D1 so you're never notified twice
- Sends a branded email only when genuinely new articles are found
- If nothing new → silence, no spam

## Search Queries

- `"Sunshine on a Ranney Day"`
- `"SOARD" charity Atlanta`
- `"Peter Ranney" nonprofit`
- `"Holly Ranney" nonprofit`
- `"Sunny and Ranney" Roswell`

## One-Time Setup

### 1. Sign up for Resend (free email API)

1. Go to [resend.com](https://resend.com) and create a free account
2. Add and verify your domain (`sunshineonaranneyday.com`) — or use their test domain to start
3. Create an API key → copy it

### 2. Deploy the Worker

```bash
cd workers/press-monitor
npx wrangler deploy
```

### 3. Set the secrets

```bash
npx wrangler secret put GITHUB_TOKEN
# paste your GitHub PAT when prompted

npx wrangler secret put RESEND_API_KEY
# paste your Resend API key when prompted

npx wrangler secret put NOTIFY_EMAIL
# type the email address you want notifications sent to
```

### 4. Seed existing URLs (one time)

Visit this URL in your browser to load all 89 existing press articles into D1:

```
https://soard-press-monitor.<your-subdomain>.workers.dev/seed
```

### 5. Test it

```
https://soard-press-monitor.<your-subdomain>.workers.dev/run
```

This triggers a full scan immediately. Check your email.

## Endpoints

| Path | Description |
|------|-------------|
| `/` | Info page |
| `/status` | How many URLs are being tracked |
| `/run` | Manually trigger a scan (same as cron) |
| `/seed` | Re-seed known URLs from GitHub |

## After Setup

Nothing. It runs on its own. You'll get an email when new press mentions are found. Add them to the site via the Admin Panel.
