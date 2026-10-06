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

## Instagram Reels

The site posts every reveal to Instagram as a Reel on its own (functions/api/_broadcast-reel.js). That uses the same Facebook app and the same page token, with two more permissions.

**Add to the same submission:** `instagram_basic` and `instagram_content_publish`. Use-case text to add:

> After each live reveal, our server posts a clip of the recording (up to 15 minutes, cut around the reveal moment) as a Reel on our own Instagram professional account, which is linked to our Facebook Page. It uses the Content Publishing API (POST /{ig-user-id}/media with media_type REELS, then media_publish). It reads only our own account's id and username. No user data is collected.

Add one extra shot to the screencast: Admin → Broadcast → Now after a reveal, showing the Reel card reach "Posted", then the Reel on instagram.com/sunshineonaranneyday.

**Before approval**, Facebook usually lets people with a role on the app use these permissions on their own accounts, so it can work right away once the token carries them.

**Regenerate the page token with the Instagram permissions** (Peter, once; secrets live only in Cloudflare):

1. Link Instagram to the Page if it isn't: Instagram app → Settings → Account type and tools → switch to a professional account → Business, then Facebook Page settings → Linked accounts → Instagram → connect.
2. developers.facebook.com/tools/explorer → pick the SOARD app → User or Page: **Get User Access Token** → tick `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `publish_video`, `instagram_basic`, `instagram_content_publish`, `business_management` → Generate → approve in the popup.
3. Access Token Tool (developers.facebook.com/tools/accesstoken) → **Extend Access Token** on that user token → copy the long-lived user token.
4. In Graph Explorer, paste the long-lived token and run `GET /me/accounts`. Copy the `access_token` of the Sunshine on a Ranney Day page. Page tokens made from a long-lived user token do not expire.
5. Cloudflare dashboard → Workers & Pages → soard-site → Settings → Variables → edit `FB_PAGE_TOKEN` → paste → Save → redeploy (any push, or Retry deployment).
6. Admin → Broadcast → Setup → **Check Instagram connection**. It should say "Linked Instagram: @sunshineonaranneyday. Ready to post." Test Facebook connection should list the new scopes.
