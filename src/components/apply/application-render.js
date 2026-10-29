/**
 * Draws the makeover application's pages from a resolved form definition
 * (functions/api/_application-form.js), as HTML, and holds the page's own
 * words (buttons, notices, the hero) in English and Spanish. Used by the page
 * at /apply/form/ and the admin's live preview, so both show what families see.
 * The browser script (application-form.client.js) reads and writes answers
 * through data-field / data-type / data-part.
 *
 * Text is escaped here; text blocks and stop screens are HTML that the
 * server cleaned when they were saved (sanitizeHtml).
 */
import { TEXT_MAX, TEXTAREA_MAX } from '../../../functions/api/_application-form.js';
import { areaMapHtml } from './area-map.js';

const CF_BASE = 'https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ';
const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const imageUrl = (id, transforms) => `${CF_BASE}/${String(id).split('/').map(encodeURIComponent).join('/')}/${transforms}`;

/**
 * The page's own words. {n} {total} {email} {pct} {name} {county} {time}
 * {year} {msg} are filled in by t(). Keys ending in Html hold a little markup.
 */
export const UI = {
  en: {
    step: 'Step {n} of {total}', part: 'Part {n} of {total}', next: 'Continue', back: 'Back', reviewBtn: 'Review my answers', toReview: 'Back to review',
    submit: 'Submit application', submitting: 'Submitting…',
    saveLater: 'Save and finish later', saving: 'Saving…', saved: 'All changes saved', savedShort: 'All changes saved', unsaved: 'Unsaved changes', paused: 'Saving paused for a moment',
    notSaved: 'Not saved yet. We will try again.', offline: 'Offline. Your answers will save when you reconnect.',
    reviewTitle: 'Review and submit', reviewIntro: 'Please look over your answers. Use Edit to change anything, then submit.',
    reviewMissing: '{n} required answers still need you', reviewMissingOne: '1 required answer still needs you', reviewReady: 'Everything is here. You can submit.',
    submitNeeds: 'Submit opens once every required answer is in.',
    edit: 'Edit', editSection: 'Edit {name}', change: 'Change', fix: 'Answer it', photoAdded: 'Photo added', videoUploaded: 'Video uploaded', notAnswered: 'Not answered yet',
    attentionOne: '1 answer on this page needs attention.', attentionMany: '{n} answers on this page need attention.',
    doneTitle: 'Thank you. Your application is in!', doneEmail: 'We just sent a message to {email} from our Qualification Committee with a copy of your application.',
    doneNext: 'What happens next',
    doneStep1: 'We read every application', doneStep1Text: 'A real person on our team reads yours from start to finish.',
    doneStep2: 'A short Zoom interview', doneStep2Text: 'Families who move forward are invited to a video call with us.',
    doneStep3: 'A visit to your home', doneStep3Text: 'We come see the space together and talk about what your child needs.',
    doneNote: 'This can take some time, and we will reach out either way.',
    doneAgain: 'This application has already been submitted. Thank you!', doneLink: "Meet some of the kids we've served",
    stopBack: 'I need to change my answer', stopApply: 'Back to the Apply page',
    laterTitle: 'Save and finish later', laterIntro: "Your answers are already saved. We'll email you a link to pick up where you left off, on this device or any other.",
    email: 'Email address', laterSend: 'Email me the link', sending: 'Sending…', sentTitle: 'Check your email', sendFail: 'We could not send the email. Please try again.',
    sentBodyHtml: 'We sent a link to <strong data-later-email></strong>. It works for 60 days after your last change. Please keep it private, since anyone with it can see your answers.',
    keepGoing: 'Keep going now', close: 'Close',
    welcomeBack: 'Welcome back! Your answers are saved, so you can pick up right where you left off.',
    remindersOff: "You won't get any more reminder emails. Your answers are still saved here.",
    expired: 'This saved application has expired. Please start a new one; we are sorry for the trouble.',
    linkExpired: 'That link has expired or is not valid. Please start a new application.',
    startFail: 'We could not start your application. Please try again.', turnstile: 'Please complete the quick check above the Continue button.',
    waitUploads: 'Please wait for your uploads to finish, then submit.', attention: 'A few answers need attention before you submit.',
    offlineSubmit: 'You seem to be offline. Your answers are saved; please try again when you are connected.',
    submitFail: 'We could not submit just now. Please try again in a minute.',
    preview: 'Preview of your unpublished form changes. Nothing you enter here is saved or sent.', previewSent: 'This is a preview, so nothing was sent.', previewNoSave: 'Saving is off in a preview.',
    previewLive: 'Live preview. Changes in the form editor show here as you make them. Nothing entered here is saved or sent.',
    previewFile: 'Preview: {name} (not uploaded)',
    noPhoto: 'No photo yet', choosePhoto: 'Choose a photo', replacePhoto: 'Replace photo', remove: 'Remove', gettingReady: 'Getting your photo ready…',
    uploading: 'Uploading… {pct}%', added: 'Added: {name}', tryAgain: '{msg}. Please try again.', uploadFailed: 'Upload failed', notImage: "That file isn't a photo we can use. Please choose a JPEG, PNG or HEIC photo.",
    dropPhoto: 'Drop the photo here', dropVideo: 'Drop the video here', orDrag: 'or drag one here',
    noVideo: 'No video yet', chooseVideo: 'Choose or record a video', chooseVideoDesk: 'Choose a video file', chooseOther: 'Choose a different video', starting: 'Starting upload…',
    uploadingPct: 'Uploading your video… {pct}%', finishing: 'Finishing up…', videoDone: 'Video uploaded: {name}', videoGone: 'Your video did not finish uploading. Please choose it again.',
    notVideo: "That file isn't a video. Please choose a video file.", uploadStartFail: 'We could not start the upload',
    empty: 'That file is empty. If it is in iCloud or Google Drive, download it to your device first.', videoHint: 'Up to 10 minutes. Please keep this page open while it uploads.',
    record: 'Record with my camera', recordStart: 'Start recording', recordStop: 'Stop and use this video', recordCancel: 'Cancel', recording: 'Recording {time}',
    camStarting: 'Starting your camera…', camReady: 'Your camera is ready. Recordings stop on their own at 10 minutes.',
    camBlocked: "We couldn't use your camera. Please allow camera access, or choose a video file instead.",
    yourPhoto: 'your photo', yourVideo: 'your video',
    leaveUpload: 'Your upload is still in progress. Leave this page and stop it?',
    suggestions: 'Suggested addresses', countyFilled: 'We filled in {county} County from your address.',
    // The service-area check under the home address
    areaPrompt: "Enter the address above, and we'll show it on the map.", areaChecking: 'Checking the address…',
    areaInside: 'Inside our service area', areaNear: 'Close to our service area', areaFar: 'Outside our service area',
    areaUnknown: "We couldn't find this address on the map", areaUnknownBody: 'Please check the street, city and ZIP code above. If they look right, just tell us:',
    areaError: "We couldn't check the address just now", areaErrorBody: 'Please tell us instead:',
    areaFound: 'We found {address}.', areaFoundCounty: 'We found {address}, in {county} County.', areaFix: 'Not right? Change the address',
    areaMapLabel: 'Map of our service area in metro Atlanta, with county lines and nearby towns.', areaMapHome: ' The home you entered is marked on it.',
    areaHome: 'Home', areaLegend: 'Our service area', areaLegendHome: 'The home you entered', areaAway: 'Home, {miles} mi away',
    stopEditAddress: 'Change the address',
    steps: 'All steps', stepDone: 'Done', stepNow: 'You are here', stepLocked: 'Not reached yet',
    // The application on its own screen (a bar across the top, the steps beside it on a computer), and the overview on the page
    appTitle: '{year} Makeover Application', saveExit: 'Save and exit', exitSaved: 'Saved. Your answers are here whenever you come back.',
    hubTitle: "Here's everything we'll ask", hubLead: '{n} steps, about 15 minutes. Your answers save as you go.',
    hubTitleBack: 'Your application is saved', hubLeadBack: '{done} of {n} steps done. About {m} minutes left.', hubLeadBackOne: '{done} of {n} steps done. About a minute left.',
    hubLeadReady: 'Every step is done. Look it over and submit.',
    hubStart: 'Start the application', hubContinue: 'Continue where you left off', hubReview: 'Review and submit', minutes: '{n} min',
    reviewOpenAll: 'Show all answers', reviewCloseAll: 'Hide the answers', reviewSection: '{n} answers', reviewSectionOne: '1 answer', reviewNeeds: 'Needs an answer',
    agreed: 'Agreed', photosAdded: '{n} photos',
    // The steps beside the form on a computer, and the bar that follows a phone down the page
    railLabel: 'Your progress', railTitle: 'Your application', leftMany: 'About {n} minutes left', leftOne: 'About a minute left', leftReview: 'Last step: look it over and submit',
    railHelp: 'Questions? We are happy to help.', miniUp: 'Back to the top of this step',
    // Optional questions tucked behind a button until wanted
    addParent2: 'Add another parent or guardian', addParentAddress: "Add the parent's address, if it's different from the child's",
    mailFix: 'Did you mean {email}?', mailFixUse: 'Use {email}',
    language: 'Language', loading: 'Loading the application…', optional: '(optional)', chooseOne: 'Choose one', choose: 'Choose', upTo: 'Choose up to {n}.',
    first: 'First name', last: 'Last name', street: 'Street address', apt: 'Apartment, suite, etc.', city: 'City', state: 'State', zip: 'ZIP code', signature: 'Type your full name',
    // The hero above the form
    heroEyebrow: 'For Families · {year} Application', heroTitleHtml: 'Tell us about your <em>child</em>.',
    heroLeadHtml: "This is where your family's story starts. The application takes about 15 minutes and <strong>saves as you go</strong>, so you can stop and come back anytime.",
    heroStart: 'Start the application', heroContinue: 'Continue my application', heroNotify: 'Get notified when we open', heroFaq: 'Questions? Read the FAQ',
    heroStatHtml: 'children served<br/>since 2012', heroPhotoAlt: 'A child enjoying their new room',
    // While closed: "tell me when applications open"
    closedTitle: 'The {year} application period is currently closed.',
    // Closed at the application limit (the same words as defaultFullMessage in functions/api/_application-cap.js)
    fullTitle: 'We’ve received all the applications we can take for {year}.',
    closedLead: "Leave your email and we'll write the moment applications open. One email, nothing else.",
    notifyLabel: 'Your email address', notifyPlaceholder: 'Your email address', notifyButton: 'Notify me', notifySending: 'Sending…', notifyDone: 'Done',
    notifyNote: "We'll email you in the language you're reading now.",
    notifyAdded: "You're on the list. We'll email you the moment applications open, and we just sent you a confirmation.",
    notifyAddedQuiet: "You're on the list. We'll email you the moment applications open.",
    notifyAlready: "You're already on the list. We'll email you the moment applications open.",
    notifyOpen: 'Good news: applications are open right now. You can start below.',
    notifyFail: 'Something went wrong. Please try again.', notifyBusy: 'Too many tries. Please wait a minute and try again.', notifyBad: 'Please enter a valid email address.',
  },
  es: {
    step: 'Paso {n} de {total}', part: 'Parte {n} de {total}', next: 'Continuar', back: 'Atrás', reviewBtn: 'Revisar mis respuestas', toReview: 'Volver a la revisión',
    submit: 'Enviar solicitud', submitting: 'Enviando…',
    saveLater: 'Guardar y terminar después', saving: 'Guardando…', saved: 'Todos los cambios están guardados', savedShort: 'Cambios guardados', unsaved: 'Cambios sin guardar', paused: 'El guardado está en pausa por un momento',
    notSaved: 'Todavía no se guardó. Lo intentaremos de nuevo.', offline: 'Sin conexión. Sus respuestas se guardarán cuando se vuelva a conectar.',
    reviewTitle: 'Revisar y enviar', reviewIntro: 'Revise sus respuestas. Use Editar para cambiar algo y después envíe la solicitud.',
    reviewMissing: 'Faltan {n} respuestas obligatorias', reviewMissingOne: 'Falta 1 respuesta obligatoria', reviewReady: 'Todo está completo. Ya puede enviarla.',
    submitNeeds: 'Podrá enviar la solicitud cuando estén todas las respuestas obligatorias.',
    edit: 'Editar', editSection: 'Editar {name}', change: 'Cambiar', fix: 'Responder', photoAdded: 'Foto agregada', videoUploaded: 'Video subido', notAnswered: 'Sin responder todavía',
    attentionOne: '1 respuesta en esta página necesita atención.', attentionMany: '{n} respuestas en esta página necesitan atención.',
    doneTitle: '¡Gracias! Recibimos su solicitud.', doneEmail: 'Le acabamos de enviar un mensaje a {email} de nuestro Comité de Calificación con una copia de su solicitud.',
    doneNext: 'Qué sigue',
    doneStep1: 'Leemos cada solicitud', doneStep1Text: 'Una persona de nuestro equipo lee la suya de principio a fin.',
    doneStep2: 'Una entrevista corta por Zoom', doneStep2Text: 'Las familias que avanzan reciben una invitación a una videollamada con nosotros.',
    doneStep3: 'Una visita a su casa', doneStep3Text: 'Vamos a ver el espacio juntos y a hablar de lo que su hijo o hija necesita.',
    doneNote: 'Esto puede tomar algo de tiempo, y nos comunicaremos con usted en cualquier caso.',
    doneAgain: 'Esta solicitud ya fue enviada. ¡Gracias!', doneLink: 'Conozca a algunos de los niños que hemos ayudado',
    stopBack: 'Necesito cambiar mi respuesta', stopApply: 'Volver a la página de solicitud',
    laterTitle: 'Guardar y terminar después', laterIntro: 'Sus respuestas ya están guardadas. Le enviaremos un enlace por correo para continuar donde se quedó, en este dispositivo o en cualquier otro.',
    email: 'Correo electrónico', laterSend: 'Enviarme el enlace', sending: 'Enviando…', sentTitle: 'Revise su correo', sendFail: 'No pudimos enviar el correo. Intente de nuevo.',
    sentBodyHtml: 'Enviamos un enlace a <strong data-later-email></strong>. Funciona durante 60 días después de su último cambio. Manténgalo privado, ya que cualquier persona que lo tenga puede ver sus respuestas.',
    keepGoing: 'Seguir ahora', close: 'Cerrar',
    welcomeBack: '¡Bienvenido de nuevo! Sus respuestas están guardadas, así que puede continuar justo donde se quedó.',
    remindersOff: 'Ya no recibirá más correos de recordatorio. Sus respuestas siguen guardadas aquí.',
    expired: 'Esta solicitud guardada venció. Comience una nueva; lamentamos la molestia.',
    linkExpired: 'Ese enlace venció o no es válido. Comience una nueva solicitud.',
    startFail: 'No pudimos comenzar su solicitud. Intente de nuevo.', turnstile: 'Complete la verificación rápida arriba del botón Continuar.',
    waitUploads: 'Espere a que terminen de subir sus archivos y después envíe la solicitud.', attention: 'Algunas respuestas necesitan atención antes de enviar.',
    offlineSubmit: 'Parece que no tiene conexión. Sus respuestas están guardadas; intente de nuevo cuando tenga conexión.',
    submitFail: 'No pudimos enviar la solicitud en este momento. Intente de nuevo en un minuto.',
    preview: 'Vista previa de los cambios sin publicar. Nada de lo que escriba aquí se guarda ni se envía.', previewSent: 'Es una vista previa, así que no se envió nada.', previewNoSave: 'Guardar está desactivado en la vista previa.',
    previewLive: 'Vista previa en vivo. Los cambios del editor aparecen aquí al instante. Nada de lo que escriba aquí se guarda ni se envía.',
    previewFile: 'Vista previa: {name} (no se subió)',
    noPhoto: 'Todavía no hay foto', choosePhoto: 'Elegir una foto', replacePhoto: 'Cambiar foto', remove: 'Quitar', gettingReady: 'Preparando su foto…',
    uploading: 'Subiendo… {pct}%', added: 'Agregada: {name}', tryAgain: '{msg}. Intente de nuevo.', uploadFailed: 'No se pudo subir', notImage: 'Ese archivo no es una foto que podamos usar. Elija una foto JPEG, PNG o HEIC.',
    dropPhoto: 'Suelte la foto aquí', dropVideo: 'Suelte el video aquí', orDrag: 'o arrástrela aquí',
    noVideo: 'Todavía no hay video', chooseVideo: 'Elegir o grabar un video', chooseVideoDesk: 'Elegir un archivo de video', chooseOther: 'Elegir otro video', starting: 'Comenzando a subir…',
    uploadingPct: 'Subiendo su video… {pct}%', finishing: 'Terminando…', videoDone: 'Video subido: {name}', videoGone: 'Su video no terminó de subirse. Elíjalo de nuevo.',
    notVideo: 'Ese archivo no es un video. Elija un archivo de video.', uploadStartFail: 'No pudimos comenzar a subir el archivo',
    empty: 'Ese archivo está vacío. Si está en iCloud o Google Drive, descárguelo primero a su dispositivo.', videoHint: 'Hasta 10 minutos. Mantenga esta página abierta mientras se sube.',
    record: 'Grabar con mi cámara', recordStart: 'Comenzar a grabar', recordStop: 'Detener y usar este video', recordCancel: 'Cancelar', recording: 'Grabando {time}',
    camStarting: 'Encendiendo su cámara…', camReady: 'Su cámara está lista. La grabación se detiene sola a los 10 minutos.',
    camBlocked: 'No pudimos usar su cámara. Permita el acceso a la cámara o elija un archivo de video.',
    yourPhoto: 'su foto', yourVideo: 'su video',
    leaveUpload: 'Todavía se está subiendo un archivo. ¿Salir de esta página y detenerlo?',
    suggestions: 'Direcciones sugeridas', countyFilled: 'Completamos el condado de {county} con su dirección.',
    areaPrompt: 'Escriba la dirección arriba y la mostraremos en el mapa.', areaChecking: 'Revisando la dirección…',
    areaInside: 'Dentro de nuestra área de servicio', areaNear: 'Cerca de nuestra área de servicio', areaFar: 'Fuera de nuestra área de servicio',
    areaUnknown: 'No encontramos esta dirección en el mapa', areaUnknownBody: 'Revise la calle, la ciudad y el código postal. Si están bien, díganos:',
    areaError: 'No pudimos revisar la dirección en este momento', areaErrorBody: 'Por favor, díganos:',
    areaFound: 'Encontramos {address}.', areaFoundCounty: 'Encontramos {address}, en el condado de {county}.', areaFix: '¿No es correcta? Cambiar la dirección',
    areaMapLabel: 'Mapa de nuestra área de servicio en el área metropolitana de Atlanta, con los límites de los condados y las ciudades cercanas.', areaMapHome: ' La casa que escribió está marcada.',
    areaHome: 'Casa', areaLegend: 'Nuestra área de servicio', areaLegendHome: 'La casa que escribió', areaAway: 'Casa, a {miles} mi',
    stopEditAddress: 'Cambiar la dirección',
    steps: 'Todos los pasos', stepDone: 'Listo', stepNow: 'Usted está aquí', stepLocked: 'Todavía no llega',
    appTitle: 'Solicitud {year}', saveExit: 'Guardar y salir', exitSaved: 'Guardado. Sus respuestas estarán aquí cuando regrese.',
    hubTitle: 'Esto es todo lo que le preguntaremos', hubLead: '{n} pasos, unos 15 minutos. Sus respuestas se guardan mientras avanza.',
    hubTitleBack: 'Su solicitud está guardada', hubLeadBack: '{done} de {n} pasos listos. Quedan unos {m} minutos.', hubLeadBackOne: '{done} de {n} pasos listos. Queda más o menos un minuto.',
    hubLeadReady: 'Todos los pasos están listos. Revise y envíe la solicitud.',
    hubStart: 'Comenzar la solicitud', hubContinue: 'Continuar donde se quedó', hubReview: 'Revisar y enviar', minutes: '{n} min',
    reviewOpenAll: 'Mostrar todas las respuestas', reviewCloseAll: 'Ocultar las respuestas', reviewSection: '{n} respuestas', reviewSectionOne: '1 respuesta', reviewNeeds: 'Falta una respuesta',
    agreed: 'De acuerdo', photosAdded: '{n} fotos',
    railLabel: 'Su progreso', railTitle: 'Su solicitud', leftMany: 'Quedan unos {n} minutos', leftOne: 'Queda más o menos un minuto', leftReview: 'Último paso: revisar y enviar',
    railHelp: '¿Preguntas? Con gusto le ayudamos.', miniUp: 'Volver al principio de este paso',
    addParent2: 'Agregar otro padre, madre o tutor', addParentAddress: 'Agregar la dirección del padre, la madre o el tutor, si es diferente a la del niño',
    mailFix: '¿Quiso decir {email}?', mailFixUse: 'Usar {email}',
    language: 'Idioma', loading: 'Cargando la solicitud…', optional: '(opcional)', chooseOne: 'Elija una opción', choose: 'Elegir', upTo: 'Elija hasta {n}.',
    first: 'Nombre', last: 'Apellido', street: 'Dirección', apt: 'Apartamento, unidad, etc.', city: 'Ciudad', state: 'Estado', zip: 'Código postal', signature: 'Escriba su nombre completo',
    heroEyebrow: 'Para familias · Solicitud {year}', heroTitleHtml: 'Cuéntenos sobre <em>su hijo o hija</em>.',
    heroLeadHtml: 'Aquí comienza la historia de su familia. La solicitud toma unos 15 minutos y <strong>se guarda mientras avanza</strong>, así que puede detenerse y volver cuando quiera.',
    heroStart: 'Comenzar la solicitud', heroContinue: 'Continuar mi solicitud', heroNotify: 'Avísenme cuando abran', heroFaq: '¿Preguntas? Lea las respuestas',
    heroStatHtml: 'niños atendidos<br/>desde 2012', heroPhotoAlt: 'Un niño disfrutando de su nuevo cuarto',
    closedTitle: 'El período de solicitudes de {year} está cerrado por ahora.',
    fullTitle: 'Ya recibimos todas las solicitudes que podemos aceptar para {year}.',
    closedLead: 'Déjenos su correo y le escribiremos en cuanto abran las solicitudes. Un solo correo, nada más.',
    notifyLabel: 'Su correo electrónico', notifyPlaceholder: 'Su correo electrónico', notifyButton: 'Avísenme', notifySending: 'Enviando…', notifyDone: 'Listo',
    notifyNote: 'Le escribiremos en el idioma en que está leyendo.',
    notifyAdded: 'Ya está en la lista. Le escribiremos en cuanto abran las solicitudes, y acabamos de enviarle una confirmación.',
    notifyAddedQuiet: 'Ya está en la lista. Le escribiremos en cuanto abran las solicitudes.',
    notifyAlready: 'Ya estaba en la lista. Le escribiremos en cuanto abran las solicitudes.',
    notifyOpen: 'Buenas noticias: las solicitudes ya están abiertas. Puede comenzar aquí abajo.',
    notifyFail: 'Algo salió mal. Inténtelo de nuevo.', notifyBusy: 'Demasiados intentos. Espere un minuto e inténtelo de nuevo.', notifyBad: 'Escriba un correo electrónico válido.',
  },
};

/**
 * The organization application's own words (/apply/community-project/, English only):
 * the ones above that speak of a child, a family or a home.
 */
export const UI_ORG = {
  doneStep2: 'A conversation with our team', doneStep2Text: 'Organizations that move forward hear from us to talk through the project.',
  doneStep3: 'A visit to see the space', doneStep3Text: 'We come see the space together and talk about what the children need.',
  doneLink: 'See the community projects we have built',
  addContact2: 'Add another contact at your organization', apt: 'Suite, building or room',
  heroFaq: 'See our community projects',
  heroEyebrow: 'For Schools, Clinics & Nonprofits · {year}', heroTitleHtml: 'Tell us about your <em>organization</em>.',
  heroLeadHtml: 'Apply for a community project for the children you serve. The application takes about 15 minutes and <strong>saves as you go</strong>, so you can stop and come back anytime.',
  heroStatHtml: 'children reached<br/>through partnerships', heroPhotoAlt: 'A space at a partner organization that SOARD transformed',
  heroNotify: 'Get in touch with us',
  appTitle: '{year} Community Project Application',
  closedTitle: 'Community project applications are closed right now.',
  closedLead: "Email us about your organization, and we'll let you know when applications open again.",
  areaMapHome: ' The address you entered is marked on it.', areaHome: 'Your address', areaLegendHome: 'The address you entered', areaAway: 'Your address, {miles} mi away',
};

/** A page word in a language, with blanks filled (kind 'organization': the organization application's words) */
export function t(lang, key, vars = {}, kind = 'family') {
  const s = (kind === 'organization' ? UI_ORG[key] : null) ?? (UI[lang] || UI.en)[key] ?? UI.en[key] ?? key;
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}

function imageHtml(id, alt, width = 938, height = 768, cls = 'af-image') {
  const srcset = [500, 700, 938].map(w => `${imageUrl(id, `w=${w},q=85`)} ${w}w`).join(', ');
  return `<figure class="${cls}"><img src="${imageUrl(id, 'w=900,q=85')}" srcset="${srcset}" sizes="(max-width: 760px) 92vw, 680px" alt="${esc(alt)}" width="${Number(width) || 938}" height="${Number(height) || 768}" loading="lazy" decoding="async"></figure>`;
}
export { imageHtml };

// A check that draws itself in (pathLength 1: the page's styles run stroke-dashoffset 1 → 0)
const CHECK = '<svg class="af-check-draw" viewBox="0 0 16 16" aria-hidden="true"><path pathLength="1" d="M3.2 8.6l3 3L12.8 5" /></svg>';
// The ring around an upload while it goes up (circumference 2πr = 113.1 at r=18), on a small disc
const RING = '<svg class="af-ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="af-ring-disc" cx="22" cy="22" r="22" /><circle class="af-ring-track" cx="22" cy="22" r="18" /><circle class="af-ring-fill" cx="22" cy="22" r="18" /></svg>';

/** Short answers with nothing to explain (Yes / No, Male / Female) sit side by side */
function sideBySide(f, plain) {
  if (f.type !== 'radio' || f.options.length < 2 || f.options.length > 3) return false;
  if (!plain && f.options.some(v => f.descriptions?.[v])) return false;
  return f.options.every(v => String(f.optionLabels?.[v] ?? v).length <= 14);
}

function choices(f, id, { plain = false } = {}) {
  const type = f.type === 'radio' || f.type === 'area' ? 'radio' : 'checkbox';
  // Choices that each explain themselves sit as tiles (two to a row where there's room)
  const tiles = !plain && f.options.length >= 3 && f.options.every(v => f.descriptions?.[v]);
  // A longer list of short answers: two columns where there's room, read down the first then the second
  const cols = !plain && !tiles && !sideBySide(f, plain) && f.options.length >= 5
    && f.options.every(v => !f.descriptions?.[v] && String(f.optionLabels?.[v] ?? v).length <= 36);
  return `<div class="af-choices${sideBySide(f, plain) ? ' af-choices--row' : ''}${tiles ? ' af-choices--tiles' : ''}${cols ? ' af-choices--cols' : ''}"${cols ? ` style="--rows:${Math.ceil(f.options.length / 2)}"` : ''}>${f.options.map((v, i) => {
    const label = f.optionLabels?.[v] ?? v;
    const desc = plain ? '' : f.descriptions?.[v];
    const text = desc ? `<strong class="af-choice-title">${esc(label)}</strong><span class="af-choice-desc">${esc(desc)}</span>` : esc(label);
    return `<label class="af-choice"><input type="${type}" name="${id}" value="${esc(v)}" id="${id}-${i}"><span class="af-choice-box" aria-hidden="true">${CHECK}</span><span class="af-choice-text">${text}</span></label>`;
  }).join('')}</div>`;
}

/**
 * An icon for each kind of makeover, matched on its name (English or Spanish); a check otherwise.
 * Phosphor Icons, duotone (MIT, phosphoricons.com): one family, one grid and weight, the second
 * tone in the brand yellow. The wheelchair's wheel is filled to match the others' yellow.
 */
const OFFER_ICONS = [
  [/bed|dorm|cuarto|habitaci/i, '<path class="af-ic-fill" d="M248,112v56H112V80H216A32,32,0,0,1,248,112Z"/><path d="M216,72H32V48a8,8,0,0,0-16,0V208a8,8,0,0,0,16,0V176H240v32a8,8,0,0,0,16,0V112A40,40,0,0,0,216,72ZM32,88h72v72H32Zm88,72V88h96a24,24,0,0,1,24,24v48Z"/>'],
  [/bath|baño|bano|shower|ducha/i, '<path class="af-ic-fill" d="M167.92,222.87A8,8,0,0,1,160,232H96a8,8,0,0,1-7.92-9.13l4.34-30.36h0a88.21,88.21,0,0,0,71.14,0h0ZM184,32H72a8,8,0,0,0-8,8v72H192V40A8,8,0,0,0,184,32Z"/><path d="M120,64a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h16A8,8,0,0,1,120,64Zm52.32,133.14,3.52,24.6A16,16,0,0,1,160,240H96a16,16,0,0,1-15.84-18.26l3.52-24.6A96.09,96.09,0,0,1,32,112a8,8,0,0,1,8-8H56V40A16,16,0,0,1,72,24H184a16,16,0,0,1,16,16v64h16a8,8,0,0,1,8,8A96.09,96.09,0,0,1,172.32,197.14ZM72,104H184V40H72Zm85.07,99.5a96.15,96.15,0,0,1-58.14,0L96,224h64ZM207.6,120H48.4a80,80,0,0,0,159.2,0Z"/>'],
  [/therap|terap/i, '<path class="af-ic-fill" d="M16,152H48v56H16a8,8,0,0,1-8-8V160A8,8,0,0,1,16,152ZM192.54,40A39.12,39.12,0,0,0,156,64a39.12,39.12,0,0,0-36.54-24C97.67,40,80,58.31,80,80c0,14.56,7,27.71,16.73,40H140a20,20,0,0,1,0,40h4l37.78-8.68C203.82,135.07,232,109.23,232,80,232,58.31,214.33,40,192.54,40Z"/><path d="M230.33,141.06a24.34,24.34,0,0,0-18.61-4.77C230.5,117.33,240,98.48,240,80c0-26.47-21.29-48-47.46-48A47.58,47.58,0,0,0,156,48.75,47.58,47.58,0,0,0,119.46,32C93.29,32,72,53.53,72,80c0,11,3.24,21.69,10.06,33a31.87,31.87,0,0,0-14.75,8.4L44.69,144H16A16,16,0,0,0,0,160v40a16,16,0,0,0,16,16H120a7.93,7.93,0,0,0,1.94-.24l64-16a6.94,6.94,0,0,0,1.19-.4L226,182.82l.44-.2a24.6,24.6,0,0,0,3.93-41.56ZM119.46,48A31.15,31.15,0,0,1,148.6,67a8,8,0,0,0,14.8,0,31.15,31.15,0,0,1,29.14-19C209.59,48,224,62.65,224,80c0,19.51-15.79,41.58-45.66,63.9l-11.09,2.55A28,28,0,0,0,140,112H100.68C92.05,100.36,88,90.12,88,80,88,62.65,102.41,48,119.46,48ZM16,160H40v40H16Zm203.43,8.21-38,16.18L119,200H56V155.31l22.63-22.62A15.86,15.86,0,0,1,89.94,128H140a12,12,0,0,1,0,24H112a8,8,0,0,0,0,16h32a8.32,8.32,0,0,0,1.79-.2l67-15.41.31-.08a8.6,8.6,0,0,1,6.3,15.9Z"/>'],
  [/ramp/i, '<circle class="af-ic-fill" cx="112" cy="160" r="60"/><path class="af-ic-fill" d="M128,48a24,24,0,1,1-24-24A24,24,0,0,1,128,48Z"/><path d="M255.59,189.47a8,8,0,0,0-10.12-5.06l-17.42,5.81-28.9-57.8A8,8,0,0,0,192,128H112V104h56a8,8,0,0,0,0-16H112V79a32,32,0,1,0-16,0V89.81A72,72,0,0,0,112,232c33.52,0,63.69-22.71,71.75-54a8,8,0,1,0-15.5-4C162.09,198,137.91,216,112,216A56,56,0,0,1,96,106.34V136a8,8,0,0,0,8,8h83.05l29.79,59.58a8,8,0,0,0,9.69,4l24-8A8,8,0,0,0,255.59,189.47ZM88,48a16,16,0,1,1,16,16A16,16,0,0,1,88,48Z"/>'],
];
const OFFER_CHECK = '<path class="af-ic-fill" d="M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z"/><path d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"/>';
const offerIcon = (title) => `<svg class="af-ic" viewBox="0 0 256 256" aria-hidden="true">${(OFFER_ICONS.find(([re]) => re.test(title || '')) || [null, OFFER_CHECK])[1]}</svg>`;

/** What a makeover includes (a card each, with its drawing), then what SOARD doesn't do */
function guidelines(f) {
  return `${f.title ? `<h3 class="af-scope-title">${esc(f.title)}</h3>` : ''}<div class="af-scope">
<div class="af-offer"><h3 class="af-offer-head">${esc(f.doTitle || 'What we do')}</h3><ul class="af-offer-grid">${(f.doItems || []).map(i => `<li class="af-offer-card"><span class="af-offer-icon">${offerIcon(i.title)}</span><span class="af-offer-text">${i.title ? `<strong>${esc(i.title.replace(/[.:]$/, ''))}</strong>` : ''}<span>${esc(i.text)}</span></span></li>`).join('')}</ul></div>
<div class="af-nope"><h3 class="af-offer-head">${esc(f.dontTitle || 'What we don’t do')}</h3><ul class="af-nope-list">${(f.dontItems || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>
</div>`;
}

/** The service-area map's words in a language (the map is drawn by ./area-map.js) */
export function mapWords(lang, home = false, kind = 'family') {
  const w = (k) => t(lang, k, {}, kind);
  return {
    label: w('areaMapLabel') + (home ? w('areaMapHome') : ''), homeLabel: w('areaHome'),
    legendArea: w('areaLegend'), legendHome: w('areaLegendHome'), away: w('areaAway'),
  };
}

/** One question (or text block) as HTML, in `lang` for the page's own words; `area` = the form's service area */
export function renderField(f, lang = 'en', area = null, kind = 'family') {
  const T = (k, v) => t(lang, k, v, kind);
  const id = `af-${f.id}`;
  const errId = `${id}-error`;
  const hintId = `${id}-hint`;
  const optional = !f.required ? `<span class="af-optional"> ${T('optional')}</span>` : '';
  const hints = [f.help, f.type === 'checkbox' && f.max ? T('upTo', { n: f.max }) : ''].filter(Boolean);
  const help = hints.length ? `<p class="af-hint" id="${hintId}">${hints.map(esc).join(' ')}</p>` : '';
  const described = `aria-describedby="${hints.length ? `${hintId} ` : ''}${errId}"`;
  if (f.type === 'content') return `<div class="af-content" data-field="${esc(f.id)}" data-type="content">${f.html || ''}</div>`;
  if (f.type === 'guidelines') return `<div class="af-content af-content--scope" data-field="${esc(f.id)}" data-type="guidelines">${guidelines(f)}</div>`;
  if (f.type === 'image') return imageHtml(f.image, f.alt, f.width, f.height).replace('<figure class="af-image">', `<figure class="af-image" data-field="${esc(f.id)}" data-type="image">`);
  // The service-area check: the map, what the check found (the script fills both in as the address
  // is typed), and the question itself, shown only when the address can't be placed on the map
  if (f.type === 'area') {
    return `<div class="af-field af-field--area" data-field="${esc(f.id)}" data-type="area"${f.required ? ' data-required="1"' : ''}>
<div class="af-area" data-area="empty">
<div class="af-map" data-area-map>${areaMapHtml(area, null, mapWords(lang, false, kind))}</div>
<div class="af-area-result" data-area-result role="status" aria-live="polite"><p class="af-area-prompt">${esc(T('areaPrompt'))}</p></div>
<fieldset class="af-area-ask" data-area-ask hidden ${described}><legend class="af-label">${esc(f.label)}</legend>${help}${choices(f, id, { plain: true })}</fieldset>
</div><p class="af-error" id="${errId}"></p></div>`;
  }

  // The person filling it in: the parent, or the organization's main contact
  const ownName = f.id === 'parentName' || f.id === 'contactName';
  const homeAddress = f.id === 'address';
  const isGroup = ['radio', 'checkbox', 'ack', 'name', 'address'].includes(f.type);
  let inner;
  if (isGroup) {
    let body = '';
    if (['radio', 'checkbox', 'ack'].includes(f.type)) body += choices(f, id);
    // The parts' names sit inside their boxes and rise to the top edge once there's an answer
    // (placeholder=" " is what lets the styles tell an empty box from a filled one)
    const part = (name, input) => `<label class="af-sub af-float">${input}<span class="af-float-label">${name}</span></label>`;
    if (f.type === 'name') {
      body += `<div class="af-row af-row--2">
${part(T('first'), `<input type="text" id="${id}-first" data-part="first" maxlength="80" autocomplete="${ownName ? 'given-name' : 'off'}" autocapitalize="words" enterkeyhint="next" placeholder=" ">`)}
${part(T('last'), `<input type="text" id="${id}-last" data-part="last" maxlength="80" autocomplete="${ownName ? 'family-name' : 'off'}" autocapitalize="words" enterkeyhint="next" placeholder=" ">`)}
</div>`;
    }
    if (f.type === 'address') {
      const ac = (v) => (homeAddress ? v : 'off');
      const list = `${id}-suggest`;
      // The suggestion list sits beside the label, not in it: a click on a suggestion mustn't count as a click on the label
      body += `<div class="af-address">
<div class="af-suggest-wrap">${part(T('street'), `<input type="text" id="${id}-line1" data-part="line1" maxlength="160" autocomplete="${ac('address-line1')}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${list}" enterkeyhint="next" placeholder=" ">`)}
<ul class="af-suggest" id="${list}" role="listbox" aria-label="${esc(T('suggestions'))}" hidden></ul></div>
${part(`${T('apt')} <span class="af-optional">${T('optional')}</span>`, `<input type="text" id="${id}-line2" data-part="line2" maxlength="80" autocomplete="${ac('address-line2')}" enterkeyhint="next" placeholder=" ">`)}
<div class="af-row af-row--3">
${part(T('city'), `<input type="text" id="${id}-city" data-part="city" maxlength="80" autocomplete="${ac('address-level2')}" enterkeyhint="next" placeholder=" ">`)}
<label class="af-sub af-float af-float--select"><select id="${id}-state" data-part="state" autocomplete="${ac('address-level1')}"><option value="">${T('choose')}</option>${US_STATES.map(s => `<option value="${s}"${homeAddress && s === 'GA' ? ' selected' : ''}>${s}</option>`).join('')}</select><span class="af-float-label">${T('state')}</span></label>
${part(T('zip'), `<input type="text" id="${id}-zip" data-part="zip" inputmode="numeric" maxlength="10" autocomplete="${ac('postal-code')}" enterkeyhint="next" placeholder=" ">`)}
</div>
<p class="af-county-note" aria-live="polite" hidden></p></div>`;
    }
    inner = `<fieldset ${described}><legend class="af-label">${esc(f.label)}${optional}</legend>${help}${body}</fieldset>`;
  } else {
    const desc = described;
    let control = '';
    switch (f.type) {
      case 'text': control = `<input type="text" id="${id}" maxlength="${f.rules?.maxLength || TEXT_MAX}" enterkeyhint="next" ${desc}>`; break;
      case 'number': control = `<input type="text" inputmode="decimal" id="${id}" maxlength="20" enterkeyhint="next" ${desc}>`; break;
      // A likely typo in the address ("gmial.com") gets a one-tap fix under it (the script fills this in)
      case 'email': control = `<input type="email" id="${id}" maxlength="160" autocomplete="${f.id === 'parentEmail' || f.id === 'contactEmail' ? 'email' : 'off'}" inputmode="email" spellcheck="false" enterkeyhint="next" ${desc}><p class="af-mailfix" data-mailfix aria-live="polite" hidden></p>`; break;
      case 'phone': control = `<input type="tel" id="${id}" maxlength="24" autocomplete="${f.id === 'parentPhone' || f.id === 'contactPhone' ? 'tel' : 'off'}" inputmode="tel" placeholder="(404) 555-0123" enterkeyhint="next" ${desc}>`; break;
      case 'date': control = `<input type="date" id="${id}" max="${new Date().toISOString().slice(0, 10)}" min="1990-01-01" ${desc}>`; break;
      case 'textarea': control = `<textarea id="${id}" rows="${Number(f.rows) || 5}" maxlength="${f.rules?.maxLength || TEXTAREA_MAX}" ${desc}></textarea>`; break;
      case 'signature': control = `<input type="text" id="${id}" class="af-signature" maxlength="120" autocomplete="name" placeholder="${esc(T('signature'))}" enterkeyhint="done" ${desc}>`; break;
      case 'select': control = `<select id="${id}" ${desc}><option value="">${T('chooseOne')}</option>${f.options.map(v => `<option value="${esc(v)}">${esc(f.optionLabels?.[v] ?? v)}</option>`).join('')}</select>`; break;
      case 'photo':
        control = `<div class="af-upload af-upload--photo" data-state="empty" data-drop>
<input type="file" id="${id}" accept="image/*" class="af-file" ${desc}>
<div class="af-upload-preview" aria-hidden="true">${RING}</div>
<div class="af-upload-body"><p class="af-upload-status" aria-live="polite">${T('noPhoto')}</p>
<div class="af-upload-actions"><button type="button" class="af-btn af-btn--upload" data-act="choose">${T('choosePhoto')}</button><span class="af-drag-hint">${T('orDrag')}</span><button type="button" class="af-btn af-btn--link" data-act="remove" hidden>${T('remove')}</button></div></div>
<div class="af-drop-veil" aria-hidden="true"><span>${T('dropPhoto')}</span></div></div>`;
        break;
      case 'video':
        control = `<div class="af-upload af-upload--video" data-state="empty" data-drop>
<input type="file" id="${id}" accept="video/*" class="af-file" ${desc}>
<div class="af-upload-preview af-upload-preview--video" aria-hidden="true">${RING}<span class="af-pct"></span></div>
<div class="af-upload-body"><p class="af-upload-status" aria-live="polite">${T('noVideo')}</p>
<div class="af-upload-actions"><button type="button" class="af-btn af-btn--upload" data-act="choose">${T('chooseVideo')}</button><button type="button" class="af-btn af-btn--ghost af-btn--sm" data-act="record" hidden>${T('record')}</button><span class="af-drag-hint">${T('orDrag')}</span><button type="button" class="af-btn af-btn--link" data-act="remove" hidden>${T('remove')}</button></div>
<p class="af-hint">${T('videoHint')}</p></div>
<div class="af-drop-veil" aria-hidden="true"><span>${T('dropVideo')}</span></div></div>
<div class="af-recorder" hidden>
<video class="af-recorder-view" muted playsinline aria-hidden="true"></video>
<div class="af-recorder-bar"><p class="af-recorder-time" aria-live="polite"></p>
<div class="af-recorder-actions"><button type="button" class="af-btn af-btn--link af-btn--on-dark" data-act="rec-cancel">${T('recordCancel')}</button>
<button type="button" class="af-btn af-btn--primary af-btn--sm" data-act="rec-toggle" disabled>${T('recordStart')}</button></div></div></div>`;
        break;
      default: control = '';
    }
    inner = `<label class="af-label" for="${id}">${esc(f.label)}${optional}</label>${help}${control}`;
  }
  return `<div class="af-field af-field--${f.type}" data-field="${esc(f.id)}" data-type="${f.type}"${f.required ? ' data-required="1"' : ''}${f.showIf ? ' hidden' : ''}>${inner}<p class="af-error" id="${errId}"></p></div>`;
}

/**
 * Optional questions most families skip, behind a button until wanted: a second parent, and the
 * parent's own address. Only when they sit together, in this order, are all optional and have no
 * show/hide rule of their own; otherwise they're drawn like any other question. The script opens
 * a group that has answers in it.
 */
export const TUCKED = [
  { key: 'parentAddress', ids: ['parentAddress'], word: 'addParentAddress' },
  { key: 'parent2', ids: ['parent2Name', 'parent2Email', 'parent2Phone', 'parent2Relation'], word: 'addParent2' },
  // The organization application's second contact
  { key: 'contact2', ids: ['contact2Name', 'contact2Title', 'contact2Email', 'contact2Phone'], word: 'addContact2' },
];
const PLUS = '<svg class="af-more-plus" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>';

/**
 * Two short questions to a row on a wider screen (the styles stack them on a phone): email beside
 * phone, a date beside a Yes / No. Never a question with help under it, a long one, one that shows or
 * hides another, or one that can stop the application, since those need the whole width to read.
 */
const PAIR_TYPES = new Set(['email', 'phone', 'date', 'number', 'select', 'text']);
const pairable = (f, leads) => !!f && !f.showIf && !f.stops && !f.help && !leads.has(f.id)
  && (PAIR_TYPES.has(f.type) || (sideBySide(f) && f.options.length === 2))
  && String(f.label || '').length <= 64;

/** A run of questions: pairs where they fit, photos side by side */
function fieldsHtml(fields, lang, area, kind, leads) {
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const n = fields[i + 1];
    // The home address beside the map that places it (the map under it on a phone)
    if (n && f.type === 'address' && n.type === 'area' && !f.showIf && !n.showIf) {
      out.push(`<div class="af-place">${renderField(f, lang, area, kind)}${renderField(n, lang, area, kind)}</div>`);
      i++;
    } else if (n && f.type === 'photo' && n.type === 'photo' && !f.showIf && !n.showIf) {
      out.push(`<div class="af-pair af-pair--photos">${renderField(f, lang, area, kind)}${renderField(n, lang, area, kind)}</div>`);
      i++;
    } else if (pairable(f, leads) && pairable(n, leads)) {
      out.push(`<div class="af-pair">${renderField(f, lang, area, kind)}${renderField(n, lang, area, kind)}</div>`);
      i++;
    } else out.push(renderField(f, lang, area, kind));
  }
  return out.join('');
}

function pageHtml(p, lang, area, kind = 'family') {
  const leads = new Set(p.fields.map(f => f.showIf?.field).filter(Boolean));
  const out = [];
  let run = [];
  const flush = () => { if (run.length) out.push(fieldsHtml(run, lang, area, kind, leads)); run = []; };
  for (let i = 0; i < p.fields.length; i++) {
    const g = TUCKED.find(x => x.ids[0] === p.fields[i].id);
    const group = g ? p.fields.slice(i, i + g.ids.length) : [];
    if (g && group.length === g.ids.length && group.every((f, k) => f.id === g.ids[k] && !f.required && !f.showIf)) {
      flush();
      const body = `af-more-${g.key}`;
      out.push(`<div class="af-more" data-more="${g.key}">
<button type="button" class="af-more-btn" data-more-open aria-expanded="false" aria-controls="${body}">${PLUS}<span>${esc(t(lang, g.word, {}, kind))}</span></button>
<div class="af-more-body" id="${body}" hidden>${fieldsHtml(group, lang, area, kind, leads)}
<button type="button" class="af-btn af-btn--link af-more-remove" data-more-close>${esc(t(lang, 'remove'))}</button></div></div>`);
      i += g.ids.length - 1;
      continue;
    }
    run.push(p.fields[i]);
  }
  flush();
  return out.join('');
}

/** Every page (hidden until the script shows the current one) */
export function renderPages(form, lang = 'en') {
  return form.pages.map(p => `<div class="af-page" data-page="${esc(p.id)}" hidden>${pageHtml(p, lang, form.serviceArea, form.kind)}</div>`).join('');
}
