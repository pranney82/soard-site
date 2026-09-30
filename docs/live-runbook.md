# Reveal day runbook

For the crew holding the phone, and for the office. Keep this short and keep it printed.

## Before reveal day (office, 5 minutes, any day ahead)

1. Admin → Broadcast → Now → **Schedule a reveal**: pick the kid, date and time. That's the countdown, the reminders, the share page and the emails.
2. Facebook → Live Producer → schedule a live video for the same time using the **persistent stream key**. (Not needed once the Live Video API is approved.)
3. Check Health: everything OK. If the reveal is tomorrow, the site re-checks by itself in the morning and alerts if anything is off.

## Reveal day (crew, 30 seconds)

1. Charge the phone. Plug in the wireless mic receiver. Put the phone on the gimbal.
2. Open **Larix Broadcaster**. Check the audio meter moves when someone talks.
3. Tap the red **record** button. You are live everywhere: the site, Facebook, YouTube.
4. When the reveal is done, tap stop. The site switches to the replay on its own, saves the recording, adds it to the kid's page, and emails the people who asked.

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
- Keep the phone in landscape.
