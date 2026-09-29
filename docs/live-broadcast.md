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
6. Cloudflare dashboard → Notifications → Destinations → Webhooks → Create with URL `https://sunshineonaranneyday.com/api/stream-webhook`, then Notifications → Add → Stream → Stream Live Notifications → attach it. (Optional but makes reactions instant. The Alerting API can do the same: `POST /accounts/{id}/alerting/v3/destinations/webhooks` then `POST /alerting/v3/policies` with `alert_type: stream_live_notifications`.)
7. Reminders → Generate push keys (browser alerts). Add Twilio env vars if texts are wanted. Add alert emails in Health.
8. Run checks in Health. Everything should read OK except optional rows.

## Reveal day

Office: nothing. Crew: open Larix, tap Start. See `docs/live-runbook.md`.

## Facebook API mode

After Facebook approves the Live Video API for the app (see `docs/facebook-app-review.md`), switch Setup → Facebook to "Live Video API". On connect the site creates the live post (`status: LIVE_NOW`, title from the schedule), points a Stream output at the ingest URL Facebook returns, and ends the post on disconnect. If Facebook refuses (error #10/#200) the site records `fb.needsReview` and falls back to the persistent key without interrupting anything.

## Troubleshooting

- **Site slow to flip (10+ s)**: the Cloudflare notification is probably not set up; Health shows "never received". The hub still polls Stream every 8 s while armed/live.
- **Hub offline / LIVE_HUB missing**: pages fall back to polling `/api/broadcast` (10 s while live). Redeploy the Worker, then the site.
- **Replay didn't attach to the kid**: the kid already had `revealVideoUrl`, or the broadcast had no kid (unplanned). Attach from the kid record; the recording is listed under History.
- **Two recordings for one reveal**: the phone was gone longer than the 30 s input timeout. Pick the right one in Now → Replay recording.
- **Encoder error alert (`ERR_GOP_OUT_OF_RANGE` etc.)**: re-scan the QR; it sets H.264, AAC, keyframe 2 s.
- **Audio problems**: use a wireless mic with its own receiver plugged into the phone, not Bluetooth (hands-free profile audio is low quality and drops in crowded rooms). Check Larix's level meter before starting.
- **Reset everything**: `POST /api/broadcast {action:'reset'}` from the admin console, or the Now tab if a broken state is showing.
