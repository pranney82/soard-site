// The application bar (../_apply-bar.js), and what the reveal schedule shows here drawn from the schedule as it is
// now (../_schedule-pages.js), so nothing moves when the page script reads it
import { applyBarMiddleware } from '../_apply-bar.js';
import { schedulePagesMiddleware } from '../_schedule-pages.js';

export const onRequest = [applyBarMiddleware, schedulePagesMiddleware];
