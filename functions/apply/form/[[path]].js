/**
 * /apply/form/: the family application, with the live form embedded (../_form-page.js)
 */
import { embedForm } from '../_form-page.js';

export const onRequest = (context) => embedForm(context, 'family');
