/**
 * /apply/community-project/: the organization application (a community project), with the live
 * organization form embedded (../_form-page.js)
 */
import { embedForm } from '../_form-page.js';

export const onRequest = (context) => embedForm(context, 'organization');
