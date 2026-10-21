/**
 * The built-in Spanish for the makeover application (version 0)
 * ===========================================================================
 * Keyed by the same paths englishStrings() gives (./_application-form.js), so
 * the editor's Spanish tab, the AI fill-in and the page all speak one shape.
 * Written for families: warm, plain, "usted". {year}, {parent}, {child},
 * {copyNote}, {percent} and HTML tags are kept exactly.
 */

const kid = 'su hijo o hija';

export const DEFAULT_ES = {
  title: 'Solicitud de Sunshine on a Ranney Day {year}',

  'page:welcome': 'Antes de comenzar',
  'page:service-area': 'Área de servicio',
  'page:basic': 'Información básica',
  'page:parents': 'Información de los padres',
  'page:diagnosis': 'Diagnóstico',
  'page:child': 'Sobre el niño o la niña',
  'page:home': 'El hogar y el espacio',
  'page:video': 'Video',
  'page:finish': 'Certificación',

  'field:introText:html': `<p><strong>¡Nos alegra mucho que esté considerando solicitar una remodelación!</strong></p>
<p>Esta solicitud nos ayuda a conocer a ${kid}, a su familia y cómo una remodelación podría marcar una diferencia en su vida diaria.</p>
<p>Como parte de la solicitud, le pediremos que:</p>
<ul>
<li>Comparta información sobre ${kid}, su familia y sus necesidades.</li>
<li>Suba fotos del espacio que le gustaría remodelar.</li>
<li>Grabe o suba un video corto de 90 segundos presentando a ${kid}, contando su historia y mostrándonos el espacio.</li>
</ul>
<p>Le recomendamos tener listas sus fotos y su video antes de comenzar, pero no es necesario completar todo de una vez. Sus respuestas se guardan a medida que avanza, y puede tocar "Guardar y terminar después" al final de cualquier página. Recibirá un enlace para volver a su solicitud cuando esté listo.</p>
<p>Sobre todo, queremos conocer a ${kid} más allá de su diagnóstico. Cuéntenos sobre su personalidad, lo que le hace feliz, los retos que enfrenta su familia y cómo una remodelación podría hacer la vida diaria un poco más fácil.</p>
<p>Gracias por tomarse el tiempo de compartir la historia de su familia con nosotros. ¡Esperamos conocerle pronto!</p>`,

  'field:scopeList:title': 'Guía de remodelaciones: lo que hacemos y lo que no ofrecemos',
  'field:scopeList:doTitle': 'Lo que hacemos',
  'field:scopeList:doItems:0:title': 'Habitaciones de ensueño',
  'field:scopeList:doItems:0:text': 'Nuestros diseñadores expertos crean una habitación hermosa para un niño o una niña que necesita un lugar cómodo y alegre para pasar el rato, recuperarse y simplemente ser niño.',
  'field:scopeList:doItems:1:title': 'Baños accesibles para silla de ruedas',
  'field:scopeList:doItems:1:text': 'Este trabajo normalmente incluye la demolición completa del baño existente y su reconstrucción con un diseño accesible: una ducha sin escalón, una puerta más ancha (cuando la estructura lo permite), barras de apoyo, un lavamanos accesible y un inodoro con espacio para transferencia lateral.',
  'field:scopeList:doItems:2:title': 'Salas de terapia en casa',
  'field:scopeList:doItems:2:text': 'Con la orientación de los terapeutas del niño o la niña, una habitación terminada de la casa se convierte en una sala de terapia donde pueda crecer y desarrollarse. El equipo de terapia depende de los fondos disponibles.',
  'field:scopeList:doItems:3:title': 'Rampas exteriores',
  'field:scopeList:doItems:3:text': 'SOARD diseña e instala rampas exteriores en la entrada de la casa, para que las personas en silla de ruedas y sus familias puedan entrar de forma segura.',
  'field:scopeList:dontTitle': 'SOARD no',
  'field:scopeList:dontItems:0': 'Instala bañeras',
  'field:scopeList:dontItems:1': 'Instala ni construye piscinas o jacuzzis',
  'field:scopeList:dontItems:2': 'Hace ampliaciones a la casa ni convierte espacios sin terminar',
  'field:scopeList:dontItems:3': 'Remodela cocinas',
  'field:scopeList:dontItems:4': 'Instala ni paga elevadores',
  'field:scopeList:dontItems:5': 'Dona ni recauda dinero para facturas, hipotecas, vehículos ni ninguna otra compra',

  'field:ackParameters:label': 'He leído lo anterior y entiendo que una remodelación de SOARD incluye trabajos de construcción y renovación en mi casa, y que SOARD solo trabaja dentro de la estructura existente de la casa, en un espacio terminado, con calefacción y aire acondicionado, libre de plomo, asbesto o moho, y en buen estado.',
  "field:ackParameters:option:Yes, I have read and understand SOARD's makeover parameters.": 'Sí, he leído y entiendo los parámetros de remodelación de SOARD.',
  'field:ackSeason:label': 'Entiendo que esta solicitud es para la temporada de remodelaciones de {year}, y que se espera que la construcción comience no antes de la primavera de {year}.',
  'field:ackSeason:option:Yes, I have read and understand the above statement.': 'Sí, he leído y entiendo lo anterior.',

  'field:serviceAreaText:html': `<p>Las remodelaciones de Sunshine on a Ranney Day son para niños cuya casa está <strong>dentro</strong> de nuestra área de servicio, que se muestra en el mapa. Escriba la dirección donde se haría la remodelación y la revisaremos por usted.</p>`,
  'field:boundary:label': '¿La casa del niño o la niña está dentro del área de servicio que se muestra en el mapa?',
  'field:boundary:option:Yes, it is within the boundary.': 'Sí, está dentro del área de servicio.',
  'field:boundary:option:No, but it is close to the boundary.': 'No, pero está cerca.',
  'field:boundary:option:No, it is not within the boundary nor is it close.': 'No, no está dentro ni cerca.',
  'field:boundary:desc:Yes, it is within the boundary.': 'Buenas noticias: esta casa está dentro de nuestra área de servicio.',
  'field:boundary:desc:No, but it is close to the boundary.': 'Esta casa está a unas {miles} millas de nuestra área de servicio. Puede presentar su solicitud, y nuestro equipo la revisará.',
  'field:boundary:desc:No, it is not within the boundary nor is it close.': 'Esta casa está a unas {miles} millas de nuestra área de servicio. Solo hacemos remodelaciones dentro de ella, así que probablemente no podamos ayudar esta vez. Si quiere, de todos modos puede enviar su solicitud.',

  'field:childName:label': 'Nombre del niño o la niña',
  'field:birthdate:label': 'Fecha de nacimiento del niño o la niña',
  'field:gender:label': 'Sexo del niño o la niña',
  'field:gender:option:Male': 'Masculino',
  'field:gender:option:Female': 'Femenino',
  'field:diagnosis:label': '¿Cuál es la enfermedad o el diagnóstico del niño o la niña?',
  'field:address:label': 'Dirección permanente del niño o la niña (dirección donde se hará la remodelación)',
  'field:county:label': '¿En qué condado está la casa del niño o la niña?',
  // County names read the same in Spanish
  'field:county:option:Cherokee': 'Cherokee',
  'field:county:option:Cobb': 'Cobb',
  'field:county:option:DeKalb': 'DeKalb',
  'field:county:option:Forsyth': 'Forsyth',
  'field:county:option:Fulton': 'Fulton',
  'field:county:option:Gwinnett': 'Gwinnett',
  'field:resides50:label': '¿El niño o la niña vive en esta dirección al menos el 50% del tiempo?',
  'field:resides50:option:Yes': 'Sí',
  'field:resides50:option:No': 'No',
  'field:previouslyApplied:label': '¿El niño o la niña ha sido nominado o ha solicitado antes una remodelación de Sunshine on a Ranney Day?',
  'field:previouslyApplied:option:Yes': 'Sí',
  'field:previouslyApplied:option:No': 'No',
  'field:referredBy:label': '¿Quién le recomendó Sunshine on a Ranney Day?',

  'field:parentName:label': 'Nombre completo del padre, la madre o el tutor legal (contacto principal para toda la comunicación)',
  'field:parentEmail:label': 'Correo electrónico del padre, la madre o el tutor legal',
  'field:parentPhone:label': 'Teléfono del padre, la madre o el tutor legal',
  'field:parentRelation:label': 'Relación con el niño o la niña',
  'field:parentAddress:label': 'Dirección del padre, la madre o el tutor legal (si es diferente a la del niño o la niña)',
  'field:parent2Name:label': 'Otro padre, madre o tutor legal',
  'field:parent2Email:label': 'Correo electrónico del otro padre, madre o tutor legal',
  'field:parent2Phone:label': 'Teléfono del otro padre, madre o tutor legal',
  'field:parent2Relation:label': 'Relación de este otro contacto con el niño o la niña',
  'field:residesWith:label': '¿Con quién vive principalmente el niño o la niña?',
  'field:ownership:label': '¿La casa donde vive el niño o la niña es propiedad de al menos una de las personas que viven allí (por ejemplo, padres, familiares o tutores), o es una propiedad alquilada?',
  'field:ownership:option:Yes, at least one person living in the home is the owner.': 'Sí, al menos una persona que vive en la casa es dueña.',
  'field:ownership:option:No, the property is rented.': 'No, la propiedad es alquilada.',

  'field:diagnosisImpact:label': `Cuéntenos sobre el diagnóstico o la enfermedad de ${kid} y cómo afecta su rutina diaria de cuidado. Esta es su oportunidad de ayudarnos a entender por qué una remodelación de SOARD haría una diferencia para su familia.`,
  'field:verbal:label': '¿El niño o la niña se comunica verbalmente?',
  'field:verbal:option:Yes': 'Sí',
  'field:verbal:option:No': 'No',
  'field:ambulatory:label': '¿El niño o la niña camina de forma independiente?',
  'field:ambulatory:option:Yes': 'Sí',
  'field:ambulatory:option:No': 'No',
  'field:sensory:label': '¿El niño o la niña tiene problemas sensoriales?',
  'field:sensory:option:Yes': 'Sí',
  'field:sensory:option:No': 'No',
  'field:sensoryDetail:label': 'Si respondió que sí, explique los problemas sensoriales',
  'field:destructive:label': '¿El niño o la niña tiene tendencias destructivas, como romper cosas en la casa, patear y hacer huecos en las paredes, etc.?',
  'field:destructive:option:Yes': 'Sí',
  'field:destructive:option:No': 'No',
  'field:destructiveDetail:label': 'Si respondió que sí, explique las tendencias destructivas.',
  'field:language:label': '¿Cuál es el idioma principal que se habla en la casa del niño o la niña?',
  'field:language:option:English': 'Inglés',
  'field:language:option:Spanish': 'Español',
  'field:language:option:French': 'Francés',
  'field:language:option:Vietnamese': 'Vietnamita',
  'field:language:option:Chinese': 'Chino',
  'field:language:option:Korean': 'Coreano',
  'field:equipment:label': 'Describa el equipo que el niño o la niña usa regularmente para moverse por la casa.',

  'field:interests:label': 'Cuéntenos todo sobre los intereses del niño o la niña. ¿Cuáles son sus personajes, programas o intereses favoritos?',
  'field:photoChild:label': 'Suba una foto del niño o la niña',
  'field:photoFamily:label': 'Suba una foto del niño o la niña con su familia',
  'field:otherChildren:label': '¿Hay otros niños en su casa con necesidades especiales o condiciones médicas? Si es así, cuéntenos un poco sobre ellos.',

  'field:makeoverTypes:label': 'Elija hasta dos (2) opciones donde el niño o la niña se beneficiaría de una remodelación.',
  'field:makeoverTypes:option:Accessible Bathroom': 'Baño accesible',
  'field:makeoverTypes:desc:Accessible Bathroom': 'Este trabajo normalmente incluye la demolición completa del baño existente y su reconstrucción con un diseño accesible: una ducha sin escalón, una puerta más ancha (cuando la estructura lo permite), barras de apoyo, un lavamanos accesible y un inodoro con espacio para transferencia lateral.',
  'field:makeoverTypes:option:Dream Bedroom': 'Habitación de ensueño',
  'field:makeoverTypes:desc:Dream Bedroom': 'Nuestros diseñadores expertos crean una habitación hermosa para un niño o una niña que necesita un lugar cómodo y alegre para pasar el rato, recuperarse y simplemente ser niño.',
  'field:makeoverTypes:option:In-Home Therapy Room': 'Sala de terapia en casa',
  'field:makeoverTypes:desc:In-Home Therapy Room': 'Con la orientación de los terapeutas del niño o la niña, una habitación terminada de la casa se convierte en una sala de terapia donde pueda crecer y desarrollarse. El equipo de terapia depende de los fondos disponibles.',
  'field:makeoverTypes:option:Ramp': 'Rampa',
  'field:makeoverTypes:desc:Ramp': 'SOARD diseña e instala rampas exteriores en la entrada de la casa, para que las personas en silla de ruedas y sus familias puedan entrar de forma segura.',
  'field:makeoverWhy:label': `¿Cuál de las opciones que eligió ayudaría más a ${kid}, y por qué?`,
  'field:positiveImpact:label': `Explique cómo esta remodelación tendría un impacto positivo en la vida de ${kid} y por qué su familia se beneficiaría de ser seleccionada. Esta es su última oportunidad para contarnos cualquier otra cosa que quiera que sepamos.`,
  'field:photoSpace1:label': 'Suba una foto del espacio',
  'field:photoSpace2:label': 'Suba una segunda foto del espacio',
  'field:residingDuration:label': '¿Cuánto tiempo planea vivir en la dirección de la remodelación?',
  'field:permits:label': 'Que usted sepa, ¿se ha hecho algún trabajo de construcción o renovación en su casa sin los permisos necesarios?',
  'field:permits:option:Yes': 'Sí',
  'field:permits:option:No': 'No',
  "field:permits:option:I'm not sure": 'No estoy seguro/a',
  'field:permitsDetail:label': 'Si respondió que sí, explique.',
  'field:conviction:label': '¿Alguna persona que vive en la dirección de la remodelación ha sido condenada por un delito grave o menor, sin contar infracciones de tránsito menores?',
  'field:conviction:option:Yes': 'Sí',
  'field:conviction:option:No': 'No',
  'field:convictionDetail:label': 'Si respondió que sí, explique.',

  'field:videoText:html': `<p>El último paso de la parte inicial de la solicitud es grabar un video corto (de unos 90 segundos) presentando a ${kid} y mostrándonos el espacio que necesita la remodelación.</p>
<p>¡El video no tiene que ser elaborado, una grabación sencilla con el teléfono es perfecta! Solo asegúrese de que aparezcan ${kid} y la habitación o el área que necesita la renovación.</p>
<p>Verifique que su video se haya procesado y subido antes de enviar su solicitud.</p>`,
  'field:video:label': 'Su video',
  'field:signature:label': 'Al escribir mi nombre a continuación, certifico que la información en esta solicitud es verdadera, exacta y completa.',

  'stop:outside:title': 'Muchas gracias por su interés en Sunshine on a Ranney Day.',
  'stop:outside:body': '<p>Nuestras remodelaciones son solo para casas dentro de nuestra área de servicio, y esta dirección está fuera de ella. Vuelva a consultar en el futuro para ver si nuestra área de servicio se ha ampliado.</p>',
  'stop:rental:title': 'Muchas gracias por su interés en Sunshine on a Ranney Day.',
  'stop:rental:body': '<p>Las familias deben ser dueñas de su casa para calificar para una remodelación.</p>',

  'message:welcome': `{parent}

La solicitud de *{child}* está en revisión.{copyNote}

Nuestro equipo evalúa con cuidado cada solicitud para determinar cómo podemos servir mejor a las familias. Si su solicitud es seleccionada para avanzar, nos comunicaremos con usted para programar una visita a su casa como el siguiente paso para completar su solicitud.

Si no podemos realizar una remodelación en este momento, también le informaremos nuestra decisión.

Tenga en cuenta que, debido al gran número de solicitudes que recibimos, este proceso puede tomar algo de tiempo. Agradecemos su paciencia mientras revisamos cada solicitud con el cuidado y la atención que merece.

Gracias de nuevo por permitirnos ser parte de su historia. Le mantendremos al tanto de cómo avanza su solicitud, pero si tiene alguna pregunta mientras tanto, no dude en comunicarse con nosotros.`,
  'message:copyNote': 'Adjuntamos una copia de su solicitud a este mensaje para sus registros.',
  'message:inReview': `{parent}

¡Felicidades! La solicitud de *{child}* pasó a la siguiente etapa, que es la visita a su casa. Después de la visita, su solicitud estará completa y lista para que nuestro equipo la revise y tome una decisión final.

Durante la visita, nuestro equipo tendrá la oportunidad de conocer a ${kid}, entender mejor sus necesidades y ver el espacio en persona.

Después de la visita y de una revisión interna, recibirá una decisión final.`,
  'message:approved': `{parent}

¡Nos alegra mucho informarle que la solicitud de *{child}* fue aprobada!

La remodelación de ${kid} ya está en nuestra lista de espera oficial. Nuestro equipo se comunicará con usted para los siguientes pasos.`,
  'message:denied': `{parent}

Después de considerar con cuidado la solicitud de *{child}*, no podemos seguir adelante con la solicitud de su familia.

Esta decisión se tomó después de un proceso de evaluación completo, que tuvo en cuenta factores como la viabilidad del proyecto, nuestros recursos actuales y las necesidades específicas de su espacio.

Entendemos que esta no es la decisión que esperaba. Le deseamos lo mejor a su familia y le agradecemos por compartir su historia con nosotros.`,
  'message:correction': `{parent}

Por favor, no tome en cuenta nuestro último mensaje sobre la solicitud de *{child}*. Se envió por error y le pedimos disculpas por la confusión.

{status}

Si tiene alguna pregunta, simplemente responda a este mensaje.`,

  'reminder:subject': 'Su solicitud de SOARD le está esperando',
  'reminder:body': `Hola, {parent}:

Usted comenzó una solicitud de remodelación de {year} para {child} con Sunshine on a Ranney Day, y sus respuestas están guardadas. Ya completó aproximadamente el {percent}%. Cuando esté listo, puede continuar justo donde se quedó.

Si tiene preguntas o necesita ayuda con alguna parte, simplemente responda a este correo.`,
};
