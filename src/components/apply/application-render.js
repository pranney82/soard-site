/**
 * Draws the makeover application's pages from a resolved form definition
 * (functions/api/_application-form.js), as HTML. Used by the page at
 * /apply/form/ and by the admin's form preview, so both show exactly what
 * families see. The browser script (application-form.client.js) reads and
 * writes answers through the data-field / data-type / data-part attributes.
 *
 * Text is escaped here; text blocks and stop screens are HTML that the
 * server cleaned when they were saved (sanitizeHtml).
 */
import { TEXT_MAX, TEXTAREA_MAX } from '../../../functions/api/_application-form.js';

const CF_BASE = 'https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ';
const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const imageUrl = (id, transforms) => `${CF_BASE}/${String(id).split('/').map(encodeURIComponent).join('/')}/${transforms}`;

function imageHtml(id, alt, width = 938, height = 768, cls = 'af-image') {
  const srcset = [500, 700, 938].map(w => `${imageUrl(id, `w=${w},q=85`)} ${w}w`).join(', ');
  return `<figure class="${cls}"><img src="${imageUrl(id, 'w=900,q=85')}" srcset="${srcset}" sizes="(max-width: 760px) 92vw, 680px" alt="${esc(alt)}" width="${Number(width) || 938}" height="${Number(height) || 768}" loading="lazy" decoding="async"></figure>`;
}
export { imageHtml };

const optionalTag = (f) => (!f.required ? '<span class="af-optional"> (optional)</span>' : '');
const help = (f) => (f.help ? `<p class="af-hint">${esc(f.help)}</p>` : '');

function choices(f, id) {
  const type = f.type === 'radio' ? 'radio' : 'checkbox';
  return `<div class="af-choices">${f.options.map((v, i) => {
    const label = f.optionLabels?.[v] ?? v;
    const desc = f.descriptions?.[v];
    const text = desc ? `<strong class="af-choice-title">${esc(label)}</strong><span class="af-choice-desc">${esc(desc)}</span>` : esc(label);
    return `<label class="af-choice"><input type="${type}" name="${id}" value="${esc(v)}" id="${id}-${i}"><span class="af-choice-box" aria-hidden="true"></span><span class="af-choice-text">${text}</span></label>`;
  }).join('')}</div>`;
}

function guidelines(f) {
  const end = (t) => (/[.!?:]$/.test(t) ? t : `${t}.`);
  return `${f.title ? `<h3 class="af-scope-title">${esc(f.title)}</h3>` : ''}<div class="af-scope">
<div class="af-scope-col"><h3>${esc(f.doTitle || 'What we do')}</h3><ul>${(f.doItems || []).map(i => `<li>${i.title ? `<strong>${esc(end(i.title))}</strong> ` : ''}${esc(i.text)}</li>`).join('')}</ul></div>
<div class="af-scope-col"><h3>${esc(f.dontTitle || 'What we don’t do')}</h3><ul>${(f.dontItems || []).map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>
</div>`;
}

/** One question (or text block) as HTML */
export function renderField(f) {
  const id = `af-${f.id}`;
  const errId = `${id}-error`;
  const hidden = f.showIf ? ' hidden' : '';
  if (f.type === 'content') return `<div class="af-content" data-field="${esc(f.id)}" data-type="content"${hidden}>${f.html || ''}</div>`;
  if (f.type === 'guidelines') return `<div class="af-content af-content--scope" data-field="${esc(f.id)}" data-type="guidelines"${hidden}>${guidelines(f)}</div>`;
  if (f.type === 'image') return imageHtml(f.image, f.alt, f.width, f.height).replace('<figure class="af-image">', `<figure class="af-image" data-field="${esc(f.id)}" data-type="image"${hidden}>`);

  const ownName = f.id === 'parentName';
  const homeAddress = f.id === 'address';
  const isGroup = ['radio', 'checkbox', 'ack', 'name', 'address'].includes(f.type);
  let inner;
  if (isGroup) {
    let body = '';
    if (f.type === 'checkbox' && f.max) body += `<p class="af-hint">Choose up to ${f.max}.</p>`;
    if (['radio', 'checkbox', 'ack'].includes(f.type)) body += choices(f, id);
    if (f.type === 'name') {
      body += `<div class="af-row af-row--2">
<label class="af-sub"><span>First name</span><input type="text" id="${id}-first" data-part="first" maxlength="80" autocomplete="${ownName ? 'given-name' : 'off'}" autocapitalize="words"></label>
<label class="af-sub"><span>Last name</span><input type="text" id="${id}-last" data-part="last" maxlength="80" autocomplete="${ownName ? 'family-name' : 'off'}" autocapitalize="words"></label>
</div>`;
    }
    if (f.type === 'address') {
      const ac = (v) => (homeAddress ? v : 'off');
      body += `<div class="af-address">
<label class="af-sub"><span>Street address</span><input type="text" id="${id}-line1" data-part="line1" maxlength="160" autocomplete="${ac('address-line1')}"></label>
<label class="af-sub"><span>Apartment, suite, etc. <span class="af-optional">(optional)</span></span><input type="text" id="${id}-line2" data-part="line2" maxlength="80" autocomplete="${ac('address-line2')}"></label>
<div class="af-row af-row--3">
<label class="af-sub"><span>City</span><input type="text" id="${id}-city" data-part="city" maxlength="80" autocomplete="${ac('address-level2')}"></label>
<label class="af-sub"><span>State</span><select id="${id}-state" data-part="state" autocomplete="${ac('address-level1')}"><option value="">Choose</option>${US_STATES.map(s => `<option value="${s}"${homeAddress && s === 'GA' ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
<label class="af-sub"><span>ZIP code</span><input type="text" id="${id}-zip" data-part="zip" inputmode="numeric" maxlength="10" autocomplete="${ac('postal-code')}"></label>
</div></div>`;
    }
    inner = `<fieldset aria-describedby="${errId}"><legend class="af-label">${esc(f.label)}${optionalTag(f)}</legend>${help(f)}${body}</fieldset>`;
  } else {
    const desc = `aria-describedby="${errId}"`;
    let control = '';
    switch (f.type) {
      case 'text': control = `<input type="text" id="${id}" maxlength="${TEXT_MAX}" ${desc}>`; break;
      case 'email': control = `<input type="email" id="${id}" maxlength="160" autocomplete="${f.id === 'parentEmail' ? 'email' : 'off'}" inputmode="email" ${desc}>`; break;
      case 'phone': control = `<input type="tel" id="${id}" maxlength="24" autocomplete="${f.id === 'parentPhone' ? 'tel' : 'off'}" inputmode="tel" placeholder="(404) 555-0123" ${desc}>`; break;
      case 'date': control = `<input type="date" id="${id}" max="${new Date().toISOString().slice(0, 10)}" min="1990-01-01" ${desc}>`; break;
      case 'textarea': control = `<textarea id="${id}" rows="${Number(f.rows) || 5}" maxlength="${TEXTAREA_MAX}" ${desc}></textarea>`; break;
      case 'signature': control = `<input type="text" id="${id}" class="af-signature" maxlength="120" autocomplete="name" placeholder="Type your full name" ${desc}>`; break;
      case 'select': control = `<select id="${id}" ${desc}><option value="">Choose one</option>${f.options.map(v => `<option value="${esc(v)}">${esc(f.optionLabels?.[v] ?? v)}</option>`).join('')}</select>`; break;
      case 'photo':
        control = `<div class="af-upload af-upload--photo" data-state="empty">
<input type="file" id="${id}" accept="image/*" class="af-file" ${desc}>
<div class="af-upload-preview" aria-hidden="true"></div>
<div class="af-upload-body"><p class="af-upload-status" aria-live="polite">No photo yet</p>
<div class="af-upload-actions"><button type="button" class="af-btn af-btn--upload" data-act="choose">Choose a photo</button><button type="button" class="af-btn af-btn--link" data-act="remove" hidden>Remove</button></div></div></div>`;
        break;
      case 'video':
        control = `<div class="af-upload af-upload--video" data-state="empty">
<input type="file" id="${id}" accept="video/*" class="af-file" ${desc}>
<div class="af-upload-body"><p class="af-upload-status" aria-live="polite">No video yet</p>
<div class="af-progress" hidden><div class="af-progress-bar"></div></div>
<div class="af-upload-actions"><button type="button" class="af-btn af-btn--upload" data-act="choose">Choose or record a video</button><button type="button" class="af-btn af-btn--link" data-act="remove" hidden>Remove</button></div>
<p class="af-hint">Up to 10 minutes. Please keep this page open while it uploads.</p></div></div>`;
        break;
      default: control = '';
    }
    inner = `<label class="af-label" for="${id}">${esc(f.label)}${optionalTag(f)}</label>${help(f)}${control}`;
  }
  return `<div class="af-field af-field--${f.type}" data-field="${esc(f.id)}" data-type="${f.type}"${f.required ? ' data-required="1"' : ''}${hidden}>${inner}<p class="af-error" id="${errId}" role="alert"></p></div>`;
}

/** Every page, the first one showing */
export function renderPages(form) {
  return form.pages.map((p, i) => `<div class="af-page" data-page="${esc(p.id)}"${i > 0 ? ' hidden' : ''}>${p.fields.map(renderField).join('')}</div>`).join('');
}
