# Facebook App Review package: Live Video API

Goal: let the site create and end the Facebook live post itself, so the crew's only action is tapping Start in Larix. Until this is approved, the persistent stream key plus a pre-scheduled post does the same job with one extra step at the office.

## What to request

In the Facebook app used for the page token (the "Live URL" app in developers.facebook.com):

- Feature: **Live Video API**
- Permissions: `publish_video`, `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` (the last two are already in use)

Prerequisites Facebook checks: the page is more than 60 days old and has at least 100 followers (both true), the app has a privacy policy URL (`https://sunshineonaranneyday.com/privacy-policy/`), a Data Deletion Instructions URL (`https://sunshineonaranneyday.com/privacy-policy/#data-deletion`, section 09 of the policy), an app icon and category, and Business Verification is complete for the business that owns the app. Business Verification is the slow part; start it first if it isn't done.

Admin → Broadcast → Setup → Facebook → **Test Facebook connection** shows the app id, the permissions the current token already has, the ones still missing, and a direct link to the app's App Review page.

## Where to submit

developers.facebook.com → the app → **App Review** → **Permissions and Features** → find "Live Video API" and each permission → **Request** → fill in the form → **Submit for review**.

## Use-case description (paste as written, adjust names)

> Sunshine on a Ranney Day is a 501(c)(3) nonprofit that builds free dream bedrooms, accessible bathrooms and therapy rooms for children with special needs in Georgia. Once a month we reveal a finished room to the child live on our Facebook page.
>
> Our website (sunshineonaranneyday.com) receives the crew's video through Cloudflare Stream and simulcasts it to our own Facebook Page (Sunshine on a Ranney Day). We use the Live Video API only for our own Page, on our own website, operated by our staff:
>
> 1. When our camera phone starts streaming, our server creates a live video on our Page (POST /{page-id}/live_videos with status LIVE_NOW and the reveal's title) and sends the RTMPS video to the ingest URL returned.
> 2. When the phone stops, our server ends the live video (end_live_video=true) so the replay is saved on the Page.
> 3. We read the live video's permalink so our website can link visitors to the Facebook post to comment and share.
>
> No user data is collected. The API is used with a Page access token for a Page we administer. Staff trigger everything from our password-protected admin at sunshineonaranneyday.com/admin (behind Cloudflare Access).

## Screencast (Facebook requires one)

Switch the app to **Development mode** first (toggle at the top of the app dashboard). In Development mode an app can use features that are still pending review for people who have a role on the app, which Peter does, so the site's API call to create the live post should succeed for real during the recording. Switch back to Live mode afterwards. If Facebook still refuses the call in Development mode, record the persistent-key flow and say in the narration that the automatic post creation is the step being requested.

Record a 2–3 minute screen recording that shows, in order:

1. Logging into the admin at sunshineonaranneyday.com/admin (blur the login).
2. Broadcast → Setup → Facebook mode set to "Live Video API".
3. Broadcast → Now: a scheduled reveal (name and time visible).
4. A phone (or OBS on the laptop, pointed at the rehearsal input for the recording) tapping Start in Larix.
5. The admin flipping to LIVE, and the Facebook Page showing the new live video with the reveal's title.
6. Stopping the stream and the Facebook post ending and becoming a saved video.

Narrate what each step does. Facebook reviewers look for: the app is used by the business for its own Page, the permission is actually exercised, and there is a way for a human to see the result.

## Test credentials field

Facebook asks for test login details. The admin is behind Cloudflare Access, so write:

> The admin is protected by Cloudflare Access (SSO for our staff). We cannot issue a reviewer login. The screencast shows the full flow end to end; the Page and the live videos it creates are public at facebook.com/SunshineOnaRanneyDay.

If the reviewer insists, create a temporary Access policy for the reviewer's email for the duration of the review, then remove it.

## After approval

Admin → Broadcast → Setup → Facebook → choose "Live Video API" → Save. The next time the phone connects, the site creates the Facebook post. Nothing else changes. If a call is refused (Facebook error #10 or #200) the site records it, shows a note under the Facebook settings, and keeps using the persistent key.

## If it is rejected

Rejections usually cite an unclear screencast or missing Business Verification. Fix the cited item and resubmit; there is no cooldown. The alternative that needs no review is a multistreaming service (Restream, StreamYard) whose Facebook connector already holds approval, at a monthly fee.
