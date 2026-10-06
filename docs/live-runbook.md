# Reveal day runbook

For the crew holding the phone, and for the office. Keep this short and keep it printed.

## Before reveal day (office, 5 minutes, any day ahead)

1. Admin → Broadcast → Now → **Schedule a reveal**: pick the kid, date and time. That's the countdown, the reminders, the share page and the emails.
2. Facebook → Live Producer → schedule a live video for the same time using the **persistent stream key**. (Not needed once the Live Video API is approved.)
3. Check Health: everything OK. If the reveal is tomorrow, the site re-checks by itself in the morning and alerts if anything is off.
4. Instagram only, within the hour before: on a computer, instagram.com → Create → Live → copy the Stream URL and key → Admin → Broadcast → Setup → Instagram simulcast → paste both → Save. Skip this if you are not streaming to Instagram.

## Reveal day (crew, 30 seconds)

1. Charge the phone. Plug in the wireless mic receiver. Put the phone on the gimbal.
2. Open **Larix Broadcaster**. Check the audio meter moves when someone talks.
3. Tap the red **record** button. You are live everywhere: the site, Facebook, YouTube.
   - **Starting early?** Put the "starting soon" screen up first (setup below), then tap record up to 30 minutes before the scheduled time. Everyone watching sees the logo and the kid's name while the room gets ready. When the reveal begins, switch that layer off. Connecting more than 30 minutes early holds the "we're live" email to the list.
4. When the reveal is done, tap stop. The site switches to the replay on its own, saves the recording, adds it to the kid's page, emails the people who asked, and posts the reveal to Instagram as a Reel about 15 to 30 minutes later.

If the phone goes live from the Facebook app instead, nothing extra is needed. Put the kid's name in the first line of the Facebook post ("Remi and Nico's reveal!"). A few hours after it ends, the site saves the replay to Stream, puts it on that kid's page, and redeploys.

## If something goes wrong

- **Larix shows "connecting" forever**: weak signal. Tap stop, switch to the **Weak signal** profile (scanned earlier), tap record again. Cellular hotspots from a second phone also work.
- **The stream dropped for a moment**: keep going. The site waits 45 seconds, Stream waits 30, and the recording stays in one piece.
- **Lost the phone profile**: open the admin on any phone → Broadcast → Setup → scan the QR again.
- **Facebook didn't go live**: Live Producer → the scheduled post → Go Live. Everything else keeps running.
- **Nothing works**: go live from the Facebook app the old way, and the office puts up the emergency banner in Broadcast → Now → "Show emergency banner".

## Audio

Bluetooth microphones are the usual cause of bad audio. Phones take Bluetooth mic input over the hands-free profile, which is low bandwidth and drops in a house full of phones and Wi-Fi.

Use a wireless mic with its own receiver that plugs into the phone's port: DJI Mic Mini or Mic 2, or a Rode Wireless Micro or Wireless GO II. They appear to the phone as a wired mic and Larix picks them up automatically. If a Bluetooth mic is the only option: pair it before opening Larix, select it under Larix → Settings → Audio, and confirm the meter moves.

## Larix settings worth turning on (once per phone)

- Settings → Connectivity → **Adaptive bitrate: Ladder ascend**. Weak signal lowers quality instead of dropping.
- Settings → Video → **Background streaming** on, so a notification doesn't stop the stream.
- Shoot **vertical**. In Larix, set the video orientation to portrait (Settings → Video) and lock the phone's rotation so it never flips mid-reveal.

## "Starting soon" screen (once per reveal)

Every kid has a starting-soon screen in the site's style: logo, "{Name}'s room reveal", the scheduled start time with a plain "in about 12 minutes" line, a slowly drifting photo, rotating QR cards (invite someone to watch, fund the next room, the kid's story) and a band of that build's partner logos.

- Screen: `https://sunshineonaranneyday.com/live/<kid>/slate/` (landscape; add `?o=portrait` for Instagram, which keeps everything clear of Instagram's header and comments)
- Still image backup: `https://sunshineonaranneyday.com/live/<kid>/starting-soon.png` (or `starting-soon-portrait.png`)

Admin → Broadcast → Now links all three once a reveal is scheduled. The start time and the photo picked in "Schedule a reveal" come through on their own, so reschedule in the admin and the screen follows.

In Larix: Settings → Overlays → add a **Web page** layer with the screen URL, full frame. (No web layer on this phone? Add an **Image** layer with the still image instead.) During the stream, the layers button turns it on and off. If Larix shows a Premium lock on overlays, Larix Premium is $9.99/month and can be cancelled after the reveal. Test it once on a practice stream before reveal day.

It also works full screen on a TV or laptop at the house: add `?tv=1` so the first card offers the stream to guests' phones (Chrome: open it, press F11 or Cmd+Ctrl+F).

Overrides, if needed: `?at=18:30` sets the start time by hand, `?photo=<image id>` swaps the photo, `?still=1` turns off motion.
