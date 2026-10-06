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
- `functions/api/_broadcast-fb.js` — Facebook Graph reads, Live Video API create/end (API mode).
- Endpoints: `broadcast.js` (public GET, admin POST), `broadcast-admin.js` (control center GET + setup POST), `stream-webhook.js`, `broadcast-hooks.js`, `live-ws.js`, `reminders.js`, `broadcast-event.js`. `live-status.js` is the legacy view over the same state.
- Front end: `src/utils/live-client.ts` (one WebSocket + polling fallback per tab), `src/components/global/LiveIndicator.astro`, `src/components/live/LivePage.astro`, `src/pages/live/index.astro`, `src/pages/live/[slug].astro`, `public/sw.js` (push handlers).
- Admin: the `Broadcast` component in `public/admin/index.html` (replaces Go Live). QR codes come from `qrcode-generator` bundled into `public/admin/vendor.js`.
- Tests: `npm test` runs `tests/broadcast.test.mjs` against a sql.js D1 shim (`tests/lib/d1-shim.mjs`). `node scripts/test-live.mjs` drives the built site and admin in Puppeteer with mocked API states.

Data (D1 `soard-db`)

- `site_config` keys `broadcast` (state), `broadcast-config` (settings, live input record incl. ingest secrets, outputs, VAPID keys), `broadcast-health` (checks, webhook stats, deploy cooldown). All three are in `RUNTIME_ONLY_KEYS` in `scripts/d1-helpers.js`, so the prebuild never writes them to `src/content`.
- Tables (created on first use by `ensureSchema`): `broadcasts`, `broadcast_reminders`, `broadcast_sends` (idempotency per broadcast+kind+channel), `broadcast_events` (analytics).

Bindings and env

- `wrangler.toml` binds `LIVE_HUB` to `LiveHub@soard-live-hub`. The binding takes effect on the next Pages deploy after the Worker exists.
- Required: `CF_ACCOUNT_ID`, `CF_STREAM_TOKEN` (Stream: Edit), `RESEND_API_KEY`, `CF_PAGES_DEPLOY_HOOK`. Already set.
- Facebook: `FB_PAGE_ID`, `FB_PAGE_TOKEN` (already set; used for permalinks and API mode).
- Optional: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` (texts); `SLACK_WEBHOOK_URL`, `ALERT_EMAILS` (alerts); `KIT_API_KEY` (drafts, already set).
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
- **Audio problems**: use a wireless mic with its own receiver plugged into the phone, not Bluetooth (hands-free profile audio is low quality and drops in crowded rooms). Check Larix's level meter before starting.
- **Reset everything**: `POST /api/broadcast {action:'reset'}` from the admin console, or the Now tab if a broken state is showing.
