// Our Kids and each kid's page: the application bar (../_apply-bar.js) and the
// reveal day put in before the page arrives (../_kid-reveal.js)
import { applyBarMiddleware } from '../_apply-bar.js';
import { kidRevealMiddleware } from '../_kid-reveal.js';

export const onRequest = [applyBarMiddleware, kidRevealMiddleware];
