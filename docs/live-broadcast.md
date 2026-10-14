# Live broadcast system

How live room reveals reach the site, Facebook and YouTube with nobody pressing anything on reveal day. Written for whoever maintains sunshineonaranneyday.com.

## The shape of it

```
phone (Larix, SRT) ──▶ Cloudflare Stream live input ──▶ simulcast ──▶ Facebook page (persistent key or Live Video API)
                              │                                    └──▶ YouTube (stream key, auto-start)
                              ├──▶ recording (automatic) ──▶ replay on the live page, captions, kid page link
                              ├──▶ Stream player on /live/<kid>/  (low-latency HLS)
                              └──▶ lifecycle endpoint ◀── site polls ──┐
                                                                      │
Cloudflare Notification (connect/disconnect) ──▶ /api/stream-webhook ─┤
soard-live-hub Durable Object (alarm every 8–60 s) ──▶ /api/broadcast-hooks ─┤
                                                                      ▼
                                          functions/api/_broadcast.js state machine (D1)
                                                                      │
                     ┌────────────────────────────────────────────────┼──────────────────────────┐
                     ▼                                                ▼                          ▼
        WebSocket push to every open page              reminders (Resend / Twilio / Web Push)   alerts (Slack / email)
        (LIVE pill, live page, admin)                  Kit drafts, audit log, analytics rows
```

**Kit "we're live" email.** Checked every tick while live (`kitAutoLive` in `_broadcast.js`). It goes out once two things are true: the stream has stayed up 3 unbroken minutes (`state.segmentAt` resets on every reconnect, so a quick phone test emails no one), and the kid is known. The kid comes from, in order: a schedule, the admin's "Which kid is this?" picker (or anything else that sets `state.kidSlug`, such as a waiting screen), the Facebook live post's title/description, then the Page's own posts from the last day, newest first (`fbRevealClues` + the archiver's `matchKids`, open kids only: no reveal video yet, this year or last; a clue naming two kids is skipped). `state.kidVia` records which. Kit sends it about a minute later (`send_at`) to `broadcast-config.kitLive.audience` (default: all subscribers), once per broadcast (`broadcast_sends` kind `live`, channel `kit`). Held with an admin alert when: a scheduled reveal starts more than 30 minutes early, no kid turns up within 30 minutes, or the kid is found by Facebook clues after 30 minutes. The emergency manual banner never sends by itself. "Email the list now" in Admin → Broadcast → Now covers every held case and retries a failed send. Each reveal also has an on/off switch (`state.kitLiveEmail`).

Stream is the origin because it gives us an authoritative "is video arriving" signal, an instant permanent recording, simulcast without a third-party service, and a player we control. Facebook stays the social destination.

## Phases

| Phase | Meaning | Set by |
|---|---|---|
| `idle` | nothing planned, no banner | expiry, cancel, reset |
| `scheduled` | a reveal has a date; countdown + reminder signup on site | admin schedule |
| `armed` | within 30 min of the date; hub polls every 8 s | timer |
| `live` | Stream lifecycle says the input is receiving video | reconcile |
| `ending` | input dropped; 45 s grace before ending | reconcile |
| `replay` | broadcast over; "Watch the replay" for `replayHours` (default 72) | reconcile / admin |

An unplanned stream (phone connects with nothing scheduled) creates a broadcast on the fly with the default title. A scheduled reveal that never streams clears itself 4 h after its time and alerts.

`source: 'manual'` is the emergency banner-only mode (old "Go Live Now"): no Stream input, links to Facebook, ends on its own timer. Stream state never touches a manual banner.

## Where things live

Code

- `workers/live-hub/` — the `soard-live-hub` Worker with the `LiveHub` Durable Object (WebSocket fan-out, alarm heartbeat, nonce issuing). Deploy with `cd workers/live-hub && npx wrangler deploy`. It has no secrets.
- `functions/api/_broadcast.js` — state machine, D1 schema, reminders, replay handling, Facebook side effects, health, admin commands.
- `functions/api/_stream-live.js` — Stream Live REST wrapper, lifecycle/viewers, Larix setup link, output presets.
- `functions/api/_broadcast-notify.js` — Resend, Twilio, Web Push (VAPID + aes128gcm, no library), ICS, email/SMS/push copy, Slack/email alerts.
- `functions/api/_broadcast-fb.js` — Facebook Graph reads, Live Video API create/end (API mode), ingest health (API mode).
- `functions/api/_broadcast-monitor.js`: the feed monitor (Control room report + the unattended watch in `runTick`). Uses `_stream-probe.js` (reads Stream's HLS like a viewer), `_aac-level.js` + `_aac-tables.js` (audio level from the AAC bitstream, no decoder), `_youtube.js` (is the channel live).
- Endpoints: `broadcast.js` (public GET, admin POST), `broadcast-admin.js` (control center GET + setup POST), `stream-webhook.js`, `broadcast-hooks.js`, `live-ws.js`, `reminders.js`, `broadcast-event.js`, `live-messages.js` (messages for the family; logic in `_live-messages.js`). `live-status.js` is the legacy view over the same state.
- `functions/live/[[path]].js`: rewrites `/live/` for the current kid and redirects unknown `/live/<kid>/` links to `/live/` (see The live page below).
- Front end: `src/utils/live-client.ts` (one WebSocket + polling fallback per tab, shared with the starting-soon iframe; watch/react/event API), `src/components/global/LiveIndicator.astro`, `src/components/live/LivePage.astro`, `src/components/live/PastReveals.astro`, `src/pages/live/index.astro`, `src/pages/live/[slug].astro`, `src/pages/reveals.astro` (every reveal video; data in `src/utils/reveals.ts`), `public/sw.js` (push handlers).
- Admin: the `Broadcast` component in `public/admin/index.html` (replaces Go Live). QR codes come from `qrcode-generator` bundled into `public/admin/vendor.js`. The Control room is `public/admin/control-room.js`, loaded on first use; its HLS player is `public/admin/vendor-hls.js` (hls.js, built by `npm run build:admin-vendor`).
- Tests: `npm test` runs `tests/broadcast.test.mjs` and `tests/live-messages.test.mjs` against a sql.js D1 shim (`tests/lib/d1-shim.mjs`). `node scripts/test-live.mjs` drives the built site and admin in Puppeteer with mocked API states. `tests/stream-probe.test.mjs` checks the audio level reader against reference clips (`tests/fixtures/aac/`), the HLS probe, destination verdicts and alerts. `node scripts/test-control-room.mjs` plays a generated feed through the Control room (needs ffmpeg; set `FFMPEG` if it isn't on PATH).

Data (D1 `soard-db`)

- `site_config` keys `broadcast` (state), `broadcast-config` (settings, live input record incl. ingest secrets, outputs, VAPID keys), `broadcast-health` (checks, webhook stats, deploy cooldown). All three are in `RUNTIME_ONLY_KEYS` in `scripts/d1-helpers.js`, so the prebuild never writes them to `src/content`.
- Tables (created on first use by `ensureSchema`): `broadcasts`, `broadcast_reminders`, `broadcast_sends` (idempotency per broadcast+kind+channel), `broadcast_events` (analytics), `broadcast_messages` (messages for the family; IPs stored only as a hash salted with the broadcast id).

Bindings and env

- `wrangler.toml` binds `LIVE_HUB` to `LiveHub@soard-live-hub`. The binding takes effect on the next Pages deploy after the Worker exists.
- Required: `CF_ACCOUNT_ID`, `CF_STREAM_TOKEN` (Stream: Edit), `RESEND_API_KEY`, `CF_PAGES_DEPLOY_HOOK`. Already set.
- Facebook: `FB_PAGE_ID`, `FB_PAGE_TOKEN` (already set; used for permalinks and API mode).
- Optional: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` (texts); `SLACK_WEBHOOK_URL`, `ALERT_EMAILS` (alerts); `KIT_API_KEY` (drafts, already set); `YOUTUBE_API_KEY` (lets the Control room and alerts confirm YouTube is live: Google Cloud → APIs & Services → enable YouTube Data API v3 → Credentials → API key, restricted to that API).
- No new secrets are required. Hub ticks are authenticated with one-time nonces verified over the private binding; the Cloudflare webhook is only a wake-up call and every decision is re-derived from Stream's lifecycle endpoint.

## Setup, once

1. Deploy the hub Worker (already deployed as `soard-live-hub` on the account; redeploy after edits with wrangler). Push the site so the `LIVE_HUB` binding applies.
2. Admin → Broadcast → Setup → **Create the live input**.
3. Scan the **Standard** QR with each phone that will stream (Larix Broadcaster installed). Scan **Weak signal** too; it adds a second profile.
4. Facebook: Live Producer → Streaming software → Advanced → Persistent stream key → paste into Setup → Facebook simulcast. Before each reveal, schedule the live post in Live Producer (a two-minute office task, any day before); Facebook auto-starts it when the stream arrives.
5. YouTube: Studio → Go live → Stream key → paste into Setup → YouTube simulcast. Turn on Auto-start and Auto-stop in Studio.
5b. Instagram (optional, per reveal): Instagram issues a new Stream URL + key for every broadcast and has no API, so before each reveal someone on a desktop opens instagram.com → Create → Live, copies both, and pastes them into Setup → Instagram simulcast. Needs a professional account. Instagram Live is portrait; set Site behavior → Camera orientation to what the crew shoots.
6. Cloudflare dashboard → Notifications → Destinations → Webhooks → Create with URL `https://sunshineonaranneyday.com/api/stream-webhook`, then Notifications → Add → Stream → Stream Live Notifications → attach it. (Optional but makes reactions instant. The Alerting API can do the same: `POST /accounts/{id}/alerting/v3/destinations/webhooks` then `POST /alerting/v3/policies` with `alert_type: stream_live_notifications`.)
7. Reminders → Generate push keys (browser alerts). Add Twilio env vars if texts are wanted. Add alert emails in Health.
8. Run checks in Health. Everything should read OK except optional rows.

## Reveal day

Office: nothing. Crew: open Larix, tap Start. See `docs/live-runbook.md`.

## Control room and feed checks

Admin → Broadcast → **Control room** (and a compact version on Now while live) plays the feed with its own HLS player instead of Stream's iframe, so the page can hear it:

- **Sound**: left/right meters (RMS and peak, dBFS) and a verdict: good, very quiet, no sound (6 s), too loud (clipping), one side only, or no audio track. A mono mic reads on both meters. "Listen here" plays it out loud. The browser may ask for one click before it can listen.
- **Picture**: feed size and frame rate, delay behind the phone, stalls, and a warning when the picture goes black or stops moving.
- **Destinations**: Website, Facebook, YouTube, Instagram Live, each OK / starting / needs a fix, with the fix and a button (Live Producer, YouTube Studio). Facebook in persistent-key mode can only see whether the Page has a live video; API mode adds Facebook's own ingest numbers, including audio bitrate. YouTube needs `YOUTUBE_API_KEY`. Instagram can't be checked.
- **Rehearsal feed**: the same player and meter on the private rehearsal input, for a mic check that never goes public.

Without anyone watching, `runTick` checks the live feed every 15 s (`_broadcast-monitor.js` → `watch`) and alerts once per problem: no audio track (after 20 s), silence for 30 s (then "audio is back" when it returns), no new video for 30 s while the phone shows connected, Facebook not live 2 min in, YouTube not live 2.5 min in. The server measures audio by decoding the AAC spectrum of the newest segments (within about 1 dB of a real decoder), because Stream encodes at a constant bitrate and file sizes say nothing about sound.

## The live page

One page component serves `/live/` (follows whatever reveal is current) and `/live/<kid>/` (that kid only; another kid's reveal never shows there).

- **The family QR code** points at `/live/?src=qr` and never changes. Admin → Broadcast → Now has it as SVG and PNG. Scans count as `qr_scan` events in History.
- **`/live/` becomes the kid's page.** While a reveal is scheduled, live or on replay, `functions/live/[[path]].js` rewrites the static page for that kid before it leaves the server: headline, story, photo, page title and share preview (`/og/kids/<kid>.png`). The response is `no-store`. Texts and Slack fetch previews fresh; Facebook caches them, so Facebook posts should use the kid's own link (the system already does).
- **Unknown kid links** (kid still a draft, a typo, an old slug) redirect to `/live/` instead of "page not found". The admin warns when a reveal is scheduled for a draft kid, since the starting-soon screen also needs the kid published.
- **Frame timeline:** kid photo and countdown, then for the last 30 minutes before the start time the starting-soon screen (`/live/<kid>/slate/?embed=1&music=0`, same origin, silent; needs `'self'` in the CSP `frame-src`), then the Stream player when the phone connects, then the replay.
- **Past reveals** (`PastReveals.astro`) close the page, and lead it when nothing is scheduled. `/reveals/` has every reveal video. Kid pages and the showcase only use a Stream video if it still plays (checked at build); otherwise YouTube.

## Watch party and messages

On a live page during the starting-soon window and while live:

- **Reactions** (love, sunshine, celebrate, wow). Taps go over the WebSocket as `{"t":"react","k":"heart"}`; the hub rate limits each socket (15 per 3 s), batches every 400 ms and sends counts to everyone watching, who see them float up over the video. Totals per reveal show in the admin.
- **Viewer count.** Live pages send `{"t":"watch"}`; only those sockets count (every page on the site holds a socket for the LIVE pill). Shown as "N watching here" from 5 viewers up; it counts the site only, not Facebook or YouTube.
- **Messages for the family.** First name plus up to 280 characters. Every message is screened before anyone sees it: local rules (links, emails, phone numbers, social handles, a short word list), then Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) with the context of a child's reveal, approving only kind, supportive or neutral notes. If screening is unavailable the message is **held** (fails closed) until someone approves it. Limits: 3 per visitor per minute, 20 per visitor per reveal, 30 per IP per minute (generous so a whole family on the house wifi can post), no duplicates, honeypot field. Shown messages reach everyone through the hub (`POST /relay` over the binding); without a hub that relays, pages poll every 20 s.
- **Admin:** Broadcast → Now → Messages: on/off switch (`config.messages.enabled`), waiting-for-review box, Hide/Show on every message, blocked ones folded away, and **Keepsake**, a print-ready page of every shown message to give the family. History links each past reveal's messages and keepsake.
- Messages stay open through the replay and close when the reveal clears.

**Deploy order:** the hub Worker carries the watch party (`watch`, reactions, `/relay`). Deploy it (`cd workers/live-hub && npx wrangler deploy`) before or with the site. With an older hub, messages still work (pages fall back to polling) but reactions and the viewer count don't.

## Instagram Reels (automatic)

Instagram has no API for going live, so every replay becomes a Reel instead (functions/api/_broadcast-reel.js), with no human step:

1. Replay ready → `state.reel` starts (`pending`). Recordings of 14:55 or less post whole (`fits`).
2. Longer ones: wait for Stream's English captions (requested when the replay is ready), score cues for reveal language ("open your eyes", countdowns, "your new room", reactions), take the densest 45 s window, and ask Workers AI (`env.AI`) for a second opinion. Agreement within 2 min → keyword time. Weak keywords → AI. Nothing found or no captions after 25 min → the last 14:55 (`fallback`). A per-reveal "reveal happens at minute" in the admin overrides everything.
3. Window = moment minus `leadSeconds` (default 4 min), up to 14:55, clamped to the recording. Stream `POST /stream/clip` makes a new video; the source is untouched.
4. Stream MP4 download → Instagram `POST /{ig-user-id}/media` (REELS, caption template, cover at the reveal) → poll `status_code` → `media_publish` → permalink.
5. The Now tab shows each stage, the chosen window and method, a preview link, and Retry / re-cut at a minute / Don't post. Outcomes alert; History links the Reel.

Needs the page token to carry `instagram_basic` and `instagram_content_publish` and a professional Instagram account linked to the Page. See docs/facebook-app-review.md → Instagram Reels. Without them the Reel stops at `blocked` with the reason and an alert; nothing else is affected.

The team shoots vertical, so Site behavior → Camera orientation defaults to portrait and the site's player is 9:16.

## Facebook API mode

After Facebook approves the Live Video API for the app (see `docs/facebook-app-review.md`), switch Setup → Facebook to "Live Video API". On connect the site creates the live post (`status: LIVE_NOW`, title from the schedule), points a Stream output at the ingest URL Facebook returns, and ends the post on disconnect. If Facebook refuses (error #10/#200) the site records `fb.needsReview` and falls back to the persistent key without interrupting anything.

## Troubleshooting

- **Site slow to flip (10+ s)**: the Cloudflare notification is probably not set up; Health shows "never received". The hub still polls Stream every 8 s while armed/live.
- **Hub offline / LIVE_HUB missing**: pages fall back to polling `/api/broadcast` (10 s while live). Redeploy the Worker, then the site.
- **How a Facebook replay finds its kid page** (`functions/api/_fb-archive.js`, fully automatic, no scheduling needed): first rule with exactly one answer wins. (1) A reveal on the Broadcast page for that time, if one happens to exist. (2) A kid named in the post's first line, among this year's and last year's kids who have no reveal replay yet. (3) The same, searching the whole post. (4) A kid named in the first line from any year, if only one matches. Names match with `&` = `and`, in any order. Old kids thanked in a post (sponsors, past families) never qualify for rules 2 and 3. Automatic placements made under older rules are re-checked once and moved if they were wrong. Only a truly ambiguous post (two of this year's kids named) needs a human: the replay is saved, admins get one alert, and History → Facebook-only broadcasts has a kid picker.
- **Linking any Stream video by hand**: every Stream video box in the kid, event and community editors has "Choose from Stream", which browses the whole Stream library by name and shows which pages already use each video. No file on the computer is needed.
- **Two recordings for one reveal**: the phone was gone longer than the 30 s input timeout. Pick the right one in Now → Replay recording.
- **Encoder error alert (`ERR_GOP_OUT_OF_RANGE` etc.)**: re-scan the QR; it sets H.264, AAC, keyframe 2 s.
- **Audio problems**: use a wireless mic with its own receiver plugged into the phone, not Bluetooth (hands-free profile audio is low quality and drops in crowded rooms). Check Larix's level meter before starting, and do a mic check on the Rehearsal feed in the Control room: speech should sit between -24 and -12 dB on both meters.
- **Reset everything**: `POST /api/broadcast {action:'reset'}` from the admin console, or the Now tab if a broken state is showing.
