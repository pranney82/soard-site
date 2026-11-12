/**
 * live-media.ts — which layout the live page is in, one definition for every part of it
 * =====================================================================================
 * The live page's parts (LivePage, LiveStage, LiveDesignRail, LiveDesign, LiveMessages,
 * LiveGive and their scripts) all switch on the same three questions. CSS can't import
 * these, so each @media there repeats the query word for word, with a note pointing here:
 * change one, change them all.
 *
 * PHONE  the phone layout: up to 960px wide, or any touch screen held sideways (the
 *        biggest Android phones turned sideways are about 1000px wide)
 * DESK   everything else: the laptop layout
 * SIDE   a phone held sideways: at least 7:4, at most 540px tall and at least 560px wide.
 *        Wide, not only "landscape": every phone held sideways is 1.78:1 or wider (an
 *        iPhone SE's 667×375) and at least 568px wide (the first SE's), while no phone held
 *        upright is 560px wide. So an on-screen keyboard that shrinks an upright phone's page
 *        (Android in-app browsers do), however short it leaves it, never flips the page
 *        sideways
 */
export const PHONE = '(max-width: 960px), (pointer: coarse) and (min-aspect-ratio: 7/4) and (max-height: 540px)';
export const DESK = '(min-width: 961px) and (pointer: fine), (min-width: 961px) and (pointer: none), (min-width: 961px) and (min-height: 541px), (min-width: 961px) and (max-aspect-ratio: 1749/1000)';
export const SIDE = '(min-aspect-ratio: 7/4) and (max-height: 540px) and (min-width: 560px) and (max-width: 960px), (min-aspect-ratio: 7/4) and (max-height: 540px) and (min-width: 560px) and (pointer: coarse)';

/** A text field: while one has focus on a phone, its on-screen keyboard is up (LivePage holds the frame's height, the
 *  corner player steps aside) */
export const typingIn = (el: Element | null): boolean =>
  !!el?.matches?.('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, [contenteditable="true"]');
