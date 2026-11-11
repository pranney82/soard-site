/**
 * /reveals/' hero, drawn from the schedule as it is now.
 *
 * The build drew the hero from the schedule it had: the next live reveal (who, when, their photo) or, with
 * none planned, the latest reveal video. When a reveal was set, moved or passed since, the page script
 * (src/pages/reveals.astro, initRevealsHero) brought it up to date after load: the "Next live reveal" line
 * appeared or went and the buttons under it moved ~110px. Now the hero goes out the way that script would
 * leave it, by the same rules and with the same words (src/utils/reveals-client.ts) in the visitor's own time
 * zone, so the script finds nothing to change.
 */

import { revealWhen } from '../src/utils/reveals-client.ts';
import { cfRaw, cfSrcset } from '../src/utils/cf-image.ts';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The words and the photo for the next reveal, as the page script writes them */
export function nextShown(n, tz, origin) {
  if (!n) return null;
  const src = n.image ? (/^https?:/.test(n.image) ? n.image : `${origin}${n.image}`) : null;
  return {
    href: n.liveUrl,
    name: n.name,
    when: n.confirmed ? revealWhen(n, 'long', tz) : n.window.label,
    img: src && {
      src: cfRaw(src, 'w=640,h=800,fit=cover,gravity=face,q=82,metadata=none'),
      srcset: cfSrcset(src, [400, 640, 800, 1024], { fit: 'cover', gravity: 'face', aspectRatio: 1.25 }),
      alt: `${n.name}, whose room reveal is next`,
      slug: n.slug,
    },
  };
}

/** The photo's img when the build had none, as the page script makes it */
export const nextImgHtml = (img, sizes) => `<img src="${esc(img.src)}" srcset="${esc(img.srcset)}"${sizes ? ` sizes="${esc(sizes)}"` : ''} alt="${esc(img.alt)}" width="640" height="800" decoding="async" data-rh-next-img data-slug="${esc(img.slug)}">`;

/**
 * Adds the hero's handlers to an HTMLRewriter. upcoming: the schedule as it is now (its first is next); signup: the
 * every-reveal email sign-up setting (null when not said)
 */
export function onRevealsHero(rw, upcoming, tz, origin, signup = null) {
  const n = nextShown(upcoming[0] || null, tz, origin);
  let sizes = '';
  let hadImg = false;
  return rw
    // "Get every reveal by email": to the band's card under the hero, or the live page's own while that card is out
    .on('[data-rh-signup]', { element(el) { if (!signup?.email) el.setAttribute('href', '/live/#remind'); } })
    .on('[data-rh-when]', {
      element(el) {
        if (!n) { el.setAttribute('hidden', ''); return; }
        el.removeAttribute('hidden');
        el.setAttribute('href', n.href);
      },
    })
    .on('[data-rh-when-name]', { element(el) { if (n) el.setInnerContent(n.name); } })
    .on('[data-rh-when-time]', { element(el) { if (n) el.setInnerContent(n.when); } })
    .on('[data-rh]', {
      element(el) {
        sizes = el.getAttribute('data-sizes') || '';
        // Nothing planned: the latest reveal video when the build has one, else the photo it drew
        if (n) el.setAttribute('data-mode', 'next');
        else if (el.hasAttribute('data-has-latest')) el.setAttribute('data-mode', 'latest');
      },
    })
    .on('[data-rh-next]', {
      element(el) {
        if (!n) return;
        el.setAttribute('href', n.href);
        // The build had no photo for this link: the next child's goes in, as the script would put it
        if (n.img) el.onEndTag((end) => { if (!hadImg) end.before(nextImgHtml(n.img, sizes), { html: true }); });
      },
    })
    .on('[data-rh-next-img]', {
      element(el) {
        hadImg = true;
        // The build's photo is the same child's (its alt names them): kept. Another child's: theirs
        if (!n?.img || (el.getAttribute('alt') || '').startsWith(`${n.name},`)) return;
        el.setAttribute('src', n.img.src);
        el.setAttribute('srcset', n.img.srcset);
        if (sizes) el.setAttribute('sizes', sizes);
        el.setAttribute('alt', n.img.alt);
        el.setAttribute('data-slug', n.img.slug);
      },
    });
}
