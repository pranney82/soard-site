# Reveal day runbook

For the crew holding the phone, and for the office. Keep this short and keep it printed.

## Before reveal day (office, 5 minutes, any day ahead)

1. Admin → Broadcast → Now → **Schedule a reveal**: pick the kid, date and time. That's the countdown, the reminders, the share page and the emails.
2. Facebook → Live Producer → schedule a live video for the same time using the **persistent stream key**. (Not needed once the Live Video API is approved.)
3. Broadcast → Now shows the **Go / no-go** for the scheduled reveal: fix anything it lists (each item has its own button). If the reveal is tomorrow, the site re-checks by itself in the morning and alerts if anything is off.
4. Sound check, before the first reveal and whenever the phone or mic changes: put the phone on the **rehearsal** profile (Admin → Broadcast → Settings → Phones → rehearsal QR), open Admin → Broadcast → Now → **Start mic check**, and talk normally. The verdict should read "Sound is good", with speech between −24 and −12 dB on both meters. Switch the starting-soon screen layer on as well: the music should also land in that band, on the quiet side. Nothing in a rehearsal reaches the public.

## Reveal day (crew, 30 seconds)

1. Charge the phone. Plug in the wireless mic receiver. Put the phone on the gimbal.
2. Open **Larix Broadcaster**. Check the audio meter moves when someone talks.
3. Tap the red **record** button. You are live everywhere: the site, Facebook, YouTube.
   - **Starting early?** Put the "starting soon" screen up first (setup below), then tap record up to 30 minutes before the scheduled time. Everyone watching sees the logo and the kid's name while the room gets ready. Mute the mic in Larix while the screen is up so viewers hear the music, not setup chatter. When the reveal begins, switch that layer off and unmute. Connecting more than 30 minutes early holds the "we're live" email to the list.
4. When the reveal is done, tap stop. The site switches to the replay on its own, saves the recording, adds it to the kid's page, emails the people who asked, and posts the reveal to Instagram as a Reel about 15 to 30 minutes later.

If the phone goes live from the Facebook app instead, nothing extra is needed. Put the kid's name in the first line of the Facebook post ("Remi and Nico's reveal!"). A few hours after it ends, the site saves the replay to Stream, puts it on that kid's page, and redeploys.

## If something goes wrong

- **Larix shows "connecting" forever**: weak signal. Tap stop, switch to the **Weak signal** profile (scanned earlier), tap record again. Cellular hotspots from a second phone also work.
- **The stream dropped for a moment**: keep going. The site waits 45 seconds, Stream waits 30, and the recording stays in one piece.
- **Lost the phone profile**: open the admin on any phone → Broadcast → Settings → Phones → scan the QR again.
- **Facebook didn't go live**: Live Producer → the scheduled post → Go Live. Everything else keeps running.
- **Nothing works**: go live from the Facebook app the old way, and the office puts up the emergency banner in Broadcast → Now → "Stream down? Put up the emergency banner".

## Audio

Bluetooth microphones are the usual cause of bad audio. Phones take Bluetooth mic input over the hands-free profile, which is low bandwidth and drops in a house full of phones and Wi-Fi.

Use a wireless mic with its own receiver that plugs into the phone's port: DJI Mic Mini or Mic 2, or a Rode Wireless Micro or Wireless GO II. They appear to the phone as a wired mic and Larix picks them up automatically. If a Bluetooth mic is the only option: pair it before opening Larix, select it under Larix → Settings → Audio, and confirm the meter moves.

## Larix settings worth turning on (once per phone)

- Settings → Connectivity → **Adaptive bitrate: Ladder ascend**. Weak signal lowers quality instead of dropping.
- Settings → Video → **Background streaming** on, so a notification doesn't stop the stream.
- Shoot **vertical**. In Larix, set the video orientation to portrait (Settings → Video) and lock the phone's rotation so it never flips mid-reveal.

## "Starting soon" screen (set up once per phone)

While the stream warms up, viewers on the site, Facebook and YouTube see a starting-soon screen in the site's style: logo, "{Name}'s room reveal", the start time, a slowly drifting photo, rotating QR cards (invite someone to watch, fund the next room, the kid's story), the rooms being built, a band of that build's partner logos, and music.

- **Start time:** taken from the reveal scheduled in Admin → Broadcast. More than an hour out it reads "Live at 6:30 PM, in about 2 hours". In the final hour it becomes a running clock ("Starting in 12:34"), and at zero it reads "Any moment now". Reschedule in the admin and the screen follows within a second.
- **Music:** plays under the countdown and fades out when the clock reaches zero, so it never plays over the reveal. The track is `live/starting-soon.mp3` on the files bucket (`files.sunshineonaranneyday.com`). Upload a replacement in the Cloudflare dashboard under R2 with the same name to change it. Use a track licensed for live streaming: Facebook and YouTube mute or cut off live video with copyrighted music. No file there means no music, and nothing breaks.
- **Which kid:** automatic. The screen follows whichever reveal is scheduled. With nothing scheduled it shows a general "Our next room reveal" screen.

**Larix, once per phone:** Settings → Overlays → add a **Web page** layer, full frame, with `https://sunshineonaranneyday.com/live/slate/`. It lays itself out portrait or landscape from the shape of the frame, so the same address works whichever way the crew shoots. Turn on **Play media** in the layer's properties and **Add internal audio** in Larix's audio settings so the music reaches the stream, and accept the prompt Larix shows for that. Never change the address again. During the stream, the layers button turns the screen on and off. If Larix shows a Premium lock on overlays, Larix Premium is $9.99/month.

Fallback without a web layer: an **Image** layer with `https://sunshineonaranneyday.com/live/<kid>/starting-soon.png` (or `starting-soon-portrait.png`). That one is per kid and has no clock or music.

**TV or laptop at the house:** `https://sunshineonaranneyday.com/live/slate/?tv=1`, full screen (Chrome: F11, or Cmd+Ctrl+F on a Mac). The first card offers the stream to guests' phones, and it stays silent. Admin → Broadcast → Now links the preview, the TV version and the still image once a reveal is scheduled.

Optional overrides on the address: `?at=18:30` (start time by hand), `?photo=<image id>`, `?music=0` (silent), `?still=1` (no motion).

## Sharing the reveal and messages for the family (office)

- **One link for everyone:** `sunshineonaranneyday.com/live`. It always shows the reveal that is coming up, live, or on replay, with that kid's name and photo. The family invite QR code in Admin → Broadcast → Now opens the same page; print it once and reuse it for every family. For Facebook posts, use the kid's own link (`/live/<kid>`), which the reminders already do.
- **Messages:** viewers can leave a note for the family on the live page. Each one is checked automatically before it shows. During the reveal, keep Admin → Broadcast → Now open: anything in **Waiting for review** needs a person (it appears there only if the automatic check was unavailable), and **Hide** takes any message down within a second. The switch at the top of the Messages card turns messages off.
- **After the reveal:** Messages → **Keepsake** makes a print-ready page of every message. Print it or save it as a PDF for the family. History keeps it for every past reveal.
