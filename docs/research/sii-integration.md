# Integración SII

> Estado: investigación histórica del 2026-08-08 para un servicio tributario separado, `sii-dte-service`. No implementa ni activa emisión tributaria.
>
> Las cuentas, terminales, precios, fuentes normativas y evidencias descritos corresponden a esa investigación; deben verificarse de nuevo antes de una implementación o decisión de producción.
>
> Alcance: Atelier del Puerto / `stock-app`, boletas electrónicas de ventas y servicios. No confundir con boletas de honorarios.

## 1. Dictamen ejecutivo

Sí, es técnicamente posible conectar `stock-app` directamente con el SII para reemplazar la emisión tributaria que hoy realiza el sistema asociado al Point vigente. El SII publica una API para recibir y consultar boletas electrónicas y no documenta una tarifa mensual ni por DTE para el acceso directo.

El escenario real no es una simple baja del servicio Mercado Pago Boletas: según la información entregada, el **Point nuevo que se integrará con `stock-app` no tiene ese servicio activo y todavía no está asociado a la panadería**. Por tanto, el objetivo económico es evitar contratarlo en el futuro; el objetivo técnico es migrar desde el emisor vigente a un motor SII propio. Cualquier mensualidad actual del terminal vigente debe confirmarse en su cuenta o facturación y no inferirse desde la foto.

Sin embargo, hay tres precisiones decisivas:

1. La integración SII sólo reemplaza la **emisión tributaria**. No reemplaza Point Smart, el procesamiento de tarjetas, las comisiones, la Orders API, los webhooks ni los reembolsos de Mercado Pago.
2. Para pagos con tarjeta o QR, el voucher de un operador autorizado puede ser la boleta. Si el contribuyente declaró ante el SII el modelo **"No emito boleta cuando recibo un pago electrónico"**, no se debe emitir además una boleta tipo 39 para esa misma venta. Esta regla sólo puede aplicarse al Point nuevo después de verificar su cuenta comercio, titular, RUT reportado, tienda/POS, entrega del voucher y modelo declarado. Efectivo y transferencia siempre requieren boleta electrónica.
3. Para un solo comercio y un solo RUT, desarrollar una solución propia únicamente por un ahorro mensual hipotético no suele ser económicamente conveniente. El desarrollo directo se justifica por automatización, control, independencia de proveedor o reutilización futura en varios comercios.

### Estado real de los dos terminales

No existe un único Point en este proyecto:

| Elemento | Point vigente en la panadería | Point nuevo para `stock-app` |
| --- | --- | --- |
| Función observada/declarada | Cobra y el sistema vigente imprime boletas electrónicas | Se pretende usar como procesador de pagos integrado |
| Evidencia tributaria | Se observó una boleta tipo 39 por una venta en efectivo y una consulta SII asociada | No usa Mercado Pago Boletas; sus comprobantes aún no son evidencia tributaria |
| Asociación comercial | Debe auditarse cuenta, titular, tienda/POS y receptor de abonos | Informada como no asociada todavía a la panadería |
| Tratamiento inicial | Sistema legado que debe mantenerse hasta un corte controlado | Fuera de producción hasta asociarlo y verificarlo; no asumir que emite o reporta boletas |

La expresión coloquial "Point registrado en el SII" debe descomponerse en relaciones distintas:

1. el terminal físico está asociado a una cuenta Mercado Pago, una aplicación, una tienda y un POS;
2. el RUT está habilitado en el SII para emitir los DTE aplicables mediante un sistema/proveedor;
3. el contribuyente declaró un modelo voucher/boleta;
4. el adquirente reporta las operaciones del terminal bajo el RUT correcto.

La integración SII no corrige un Point perteneciente a otra cuenta o contribuyente ni cambia el destino de sus liquidaciones. Antes de una venta real, el nuevo terminal debe quedar asociado a la cuenta comercial autorizada de la panadería y coincidir con el Access Token, `user_id`/collector, tienda, POS, modo PDV y cuenta receptora esperados.

### Evidencia real revisada

- La foto del comprobante muestra una **Boleta Electrónica**, no un voucher de tarjeta: tiene tipo documental, folio, emisor, desglose neto/IVA/total y medio de pago efectivo. Confirma que el sistema vigente fue capaz de emitir un DTE 39 para esa venta; que se imprimió desde un Point proviene del contexto entregado por el usuario, porque el papel no identifica software, proveedor ni serial del hardware. No demuestra que el Point nuevo tenga la misma capacidad.
- La representación impresa no incluye TED/PDF417 visible. Eso es compatible con que su impresión sea opcional desde 2026; el TED sigue siendo obligatorio dentro del XML.
- La interfaz fotografiada del SII es una consulta pública manual por RUT, tipo y folio, protegida por CAPTCHA. No es una API para `stock-app` y no se debe automatizar ni scrapear.
- El PDF posterior es una impresión de navegador, no un certificado firmado por el SII. Informa **"Documento Recibido por el SII"** y entrega un identificador de envío: es evidencia humana complementaria de que la combinación emisor/tipo/folio fue informada, no una prueba criptográfica del contenido ni de que monto, IVA, fecha y líneas impresas coincidan con el XML.
- El identificador de envío pertenece al sobre y puede cubrir varios DTE. La hora visible es la de la consulta, no necesariamente la de recepción. Esta evidencia no identifica al proveedor o terminal físico y no sustituye la conservación del XML firmado ni la reconciliación automatizada hasta estado tributario final. `received`, HTTP 200 y Track ID nunca se modelarán como `accepted`.
- La leyenda normativa impresa no es una marca de Mercado Pago ni identifica el software emisor.
- El folio observado es sólo una muestra; no se asumirá como último folio ni como inventario de CAF.

Por minimización de datos, las imágenes, el PDF y sus identificadores personales/tributarios no se copian al repositorio. Para la migración se conservará evidencia operativa sanitizada y los XML/reportes se obtendrán por un canal autorizado.

### Recomendación para Atelier

La primera recomendación es mantener el sistema tributario vigente mientras se auditan y regularizan por separado ambos terminales. El Point nuevo no debe operar ventas reales de la panadería si su cuenta/titular/RUT o el destino de los abonos no corresponden al comercio, y ningún comprobante suyo debe clasificarse todavía como voucher tributario.

Después de esa verificación existen dos políticas posibles:

- **Siempre-boleta (preferida para independencia):** Mercado Pago procesa el pago y `stock-app` emite DTE propio para efectivo, transferencia, tarjeta y QR. El comprobante Point es evidencia financiera adicional, no la evidencia tributaria primaria.
- **Híbrida:** voucher previamente verificado para tarjeta/QR y DTE propio sólo para efectivo/transferencia. Sólo es válida si el Point reporta bajo el RUT correcto y coincide con el modelo "No emito boleta con pago electrónico" declarado en el SII.

La decisión final debe validarse con el contador y con evidencia de la configuración actual del RUT. No se cancela una suscripción ni se revoca un proveedor hasta confirmar que realmente existe, identificar quién controla los CAF/documentos vigentes y completar un corte seguro.

## 2. Costo que podría evitarse, sujeto a confirmar la cuenta vigente

La página pública de Mercado Pago indica, a la fecha de este análisis, los siguientes precios. Son una comparación comercial y **no prueban que alguno de los dos terminales tenga hoy esa suscripción activa**:

| Servicio | Precio publicado después de 6 meses gratis |
| --- | ---: |
| Boletas | `$11.000 + IVA/mes` o `$105.600 + IVA/año` |
| Boletas y facturas | `$38.000 + IVA/mes` o `$364.800 + IVA/año` |

Mercado Pago también declara que:

- el comprobante de tarjeta, débito o QR es válido como boleta y esas ventas son informadas al SII;
- el servicio adicional de boletas permite incluir efectivo;
- el modelo de emisión debe configurarse correctamente para no duplicar ventas.

Por lo tanto, el ahorro potencial corresponde a no contratar o reemplazar el complemento de boletas, no al servicio de cobro con Point. El Point nuevo no tiene hoy un servicio tributario que cancelar; el servicio exacto detrás del terminal vigente aún debe identificarse.

Fuente: [Mercado Pago Point Smart 2](https://www.mercadopago.cl/herramientas-para-vender/lectores-point/point-smart-2).

## 3. Decisión tributaria que debe tomarse primero

Todos los contribuyentes deben declarar ante el SII cómo combinarán boleta electrónica y voucher. Esa declaración rige desde que se realiza y sólo puede cambiarse una vez al día.

| Medio de pago | Modelo "No emito boleta con pago electrónico" | Modelo "Siempre emito boleta" |
| --- | --- | --- |
| Efectivo | DTE 39 o 41, según corresponda | DTE 39 o 41, según corresponda |
| Transferencia bancaria | DTE 39 o 41, según corresponda | DTE 39 o 41, según corresponda |
| Tarjeta o QR con operador autorizado | Voucher; no emitir otro DTE por la misma venta | Voucher y DTE 39/41, bajo el modelo declarado |
| Pago mixto | Definir una regla contable antes de soportarlo; la aplicación actual no lo modela | Definir una regla contable antes de soportarlo |

Reglas para el diseño:

- No inferir el modelo a partir del método de pago: guardarlo como configuración del emisor y registrar una copia inmutable de la política aplicada en cada venta.
- No inferir que cualquier comprobante Point es un voucher tributario. Una acreditación de pago, un recibo financiero, un voucher electrónico verificado, un DTE emitido por un proveedor y un DTE propio son evidencias distintas.
- Hasta verificar el Point nuevo, toda tarjeta/QR queda en `manual_review` tributario o se emite como DTE propio bajo el modelo "Siempre emito boleta"; nunca se omite el DTE sólo por el método de pago.
- No emitir tipo 41 sólo porque exista soporte técnico. Un contador debe confirmar que el giro y la operación son exentos.
- Para una venta respaldada únicamente por voucher no existe un folio DTE 39 propio al cual referenciar una nota de crédito. Un reembolso de Mercado Pago y una corrección tributaria son procesos distintos; el procedimiento exacto debe validarse con SII, Mercado Pago y el contador.
- Para una boleta propia 39/41 aceptada, una anulación o corrección posterior se realiza mediante DTE 61. No se debe marcar una nota de crédito como emitida sólo porque el dinero fue reembolsado.

Fuente principal: [SII, "Tu Voucher es tu Boleta"](https://www.sii.cl/destacados/boleta_electronica_voucher/index.html).

## 4. Comparación económica y operativa

Precios revisados el 2026-08-05. Pueden cambiar y deben volver a verificarse antes de contratar o cancelar.

| Alternativa | Costo publicado | Automatiza efectivo/transferencia | Carga técnica | Recomendación |
| --- | --- | --- | --- | --- |
| Voucher MP verificado + e-Boleta SII manual | Sin mensualidad de emisión | No | Baja | Sólo después de acreditar asociación y elegibilidad tributaria del Point |
| Mercado Pago Boletas | `$105.600 + IVA/año` pagando anual | Sí | Muy baja | Mejor servicio administrado para un solo RUT |
| SimpleAPI DTE Básico | `5 UF + IVA/año`, más certificado; primer año gratuito con 500 consultas/mes | Sí | Media | Acelera integración, pero no elimina costo recurrente |
| Facto con boleta + API | Desde aproximadamente `$435.000 + IVA/año`, según planes publicados | Sí | Baja/media | Más caro para este caso; aporta ERP y operación administrada |
| Integración directa SII | Sin tarifa SII documentada por llamada/DTE | Sí | Alta | Sólo por valor estratégico o reutilización |

Notas:

- SimpleAPI publica un plan gratuito por 12 meses y 500 consultas mensuales. Una consulta no equivale necesariamente a una boleta: generar, enviar y consultar estado pueden ser operaciones separadas. El plan Básico publicado es de 5 UF + IVA al año y 10.000 consultas mensuales.
- SimpleAPI abstrae XML, firma y envío, pero introduce una API propietaria y el manejo de certificado/clave a través de su infraestructura. Debe existir una evaluación contractual y de seguridad antes de enviar un PFX.
- Facto ofrece facturación básica gratuita, pero la boleta es una prestación pagada. La API es un complemento adicional; usar Facto gratis para "certificarse y salir" no es una estrategia suficiente ni documenta por sí sola un cambio de proveedor seguro.
- La integración directa sigue teniendo costos de certificado digital, ingeniería, certificación, hosting, almacenamiento, monitoreo, soporte y mantenimiento normativo.

Fuentes: [SimpleAPI precios](https://www.simpleapi.cl/Precios), [SimpleAPI certificación](https://www.simpleapi.cl/Certificacion), [Facto precios](https://facto.cl/precios/) y [ayuda de activación Facto](https://ayuda.facto.cl/cu%C3%A1les-son-los-pasos-para-operar-con-facto).

## 5. Qué ofrece realmente la API oficial

La especificación oficial disponible en [OpenAPI 1.0.5](https://www4c.sii.cl/bolcoreinternetui/api/openapi.json) expone para boletas 39 y 41:

- `GET /boleta.electronica.semilla`
- `POST /boleta.electronica.token`
- `POST /boleta.electronica.envio`
- `GET /boleta.electronica.envio/{rut}-{dv}-{trackid}`
- `GET /boleta.electronica/{rut}-{dv}-{tipo}-{folio}/estado`
- catálogos de estados, tipos, niveles y secciones.

Ambientes publicados por la propia especificación:

- certificación: `https://apicert.sii.cl/recursos/v1`; `pangal.sii.cl` figura como servidor temporal exclusivo para upload;
- producción: `https://api.sii.cl/recursos/v1`; `rahue.sii.cl` figura como servidor temporal exclusivo para upload.

La API no recibe un JSON comercial y no construye el DTE. El sistema propio debe:

1. Obtener un CAF y reservar un folio autorizado.
2. Construir el DTE XML en el orden exacto definido por el XSD vigente.
3. Generar y firmar el TED con la clave contenida en el CAF.
4. Firmar el DTE y el sobre XML con el certificado digital del firmante autorizado.
5. Validar localmente el XML contra el XSD antes de enviarlo.
6. Obtener una semilla, firmarla, canjearla por token y enviar el token en `Cookie: TOKEN=...`.
7. Subir `EnvioBOLETA` mediante `multipart/form-data`.
8. Guardar el Track ID y consultar hasta un estado final.
9. Tratar HTTP 200 como recepción técnica, no como aceptación tributaria.
10. Entregar al cliente la representación exigida y conservar el XML.

La OpenAPI indica que la semilla dura 2 minutos; el token mantiene una actividad de 1 hora y se renueva al usarlo. También recomienda lotes de 50 boletas y esperar aproximadamente 10 minutos antes de consultar, aunque el formato permite hasta 500 boletas por sobre.

El token todavía exige XMLDSIG con C14N 2001, RSA-SHA1, transformación enveloped y digest SHA1. Es una excepción de compatibilidad requerida por el SII: no habilita desactivar TLS ni usar SHA1 fuera del protocolo exacto.

### DTE 61 no usa esta misma superficie REST

La OpenAPI de boletas cubre 39 y 41. La nota de crédito 61 pertenece al flujo general de DTE y requiere su propio formato, certificación y transporte SII. No se debe asumir que `POST /boleta.electronica.envio` acepta notas de crédito.

Antes de producción debe cumplirse una de estas condiciones:

- tipo 61 automático certificado y probado de extremo a extremo; o
- procedimiento manual oficial, probado y asignado a un responsable, para cada corrección/anulación, sin afirmar en la aplicación que fue emitido hasta registrar su folio y estado real.

## 6. Normativa y requisitos vigentes que cambian el diseño

### Envío y conservación

- Cada boleta debe enviarse inmediatamente, con plazo máximo de una hora. Si no existe cobertura, el plazo se cuenta desde el restablecimiento de la conexión.
- Cada folio autorizado se usa una sola vez.
- Los XML deben conservarse al menos seis años.
- El emisor debe mantener consulta en línea en la sucursal para el mes actual y los dos anteriores, y poner la boleta a disposición del cliente durante tres meses según el formato/instructivo aplicable.

Fuente: [Resolución Ex. SII N° 74 de 2020](https://www.sii.cl/normativa_legislacion/resoluciones/2020/reso74.pdf) y [formato de boleta v4.2, 2025-09-08](https://www.sii.cl/factura_electronica/factura_mercado/formato_boleta_electronica.pdf).

### RVD/RCOF: obligación eliminada en producción

El Resumen de Ventas Diarias, antes Reporte de Consumo de Folios, dejó de ser obligatorio para operaciones desde el 1 de agosto de 2022, para todos los sistemas. El Registro de Compras y Ventas se alimenta de las boletas recibidas por el SII.

Hay páginas antiguas, instructivos y librerías que aún dicen que debe enviarse diariamente. Incluso el proceso de certificación puede solicitar un RCF como artefacto de prueba. La regla de implementación será:

- no crear un job productivo diario de RVD;
- conservar soporte de certificación/legado sólo si el set vigente asignado por el SII lo exige;
- resolver cualquier contradicción mediante la Resolución Ex. SII N° 53 de 2022 y una confirmación escrita del SII.

Fuente: [FAQ SII actualizada el 2026-07-20](https://www.sii.cl/preguntas_frecuentes/bol_electr_vtas_serv/001_380_7679.htm) y [Resolución Ex. SII N° 53 de 2022](https://www.sii.cl/normativa_legislacion/resoluciones/2022/reso53.pdf).


### Entrega al comprador

La Resolución Ex. SII N° 53 de 2025 exige entregar o poner a disposición la representación impresa o virtual de la boleta/voucher en ventas presenciales. Las obligaciones rigen desde el 1 de mayo de 2025 para dispositivos con impresión y desde el 1 de marzo de 2026 para otros dispositivos. Una entrega virtual puede utilizar, según el caso, correo, SMS, mensajería, fotografía, NFC o QR.

Desde el 1 de enero de 2026, la Resolución Ex. SII N° 207 de 2025 hizo opcional imprimir el timbre electrónico/PDF417 en la representación impresa. El TED continúa siendo obligatorio dentro del XML.

Fuentes: [Resolución Ex. SII N° 53 de 2025](https://www.sii.cl/normativa_legislacion/resoluciones/2025/reso53.pdf) y [Resolución Ex. SII N° 207 de 2025](https://www.sii.cl/normativa_legislacion/resoluciones/2025/reso207.pdf).

### Certificación

El sistema gratuito del SII no requiere certificar software, pero no ofrece integración con aplicaciones del contribuyente. Un sistema propio o de mercado debe completar la habilitación/certificación aplicable:

1. Postulación o acceso al ambiente de certificación por el representante legal.
2. Descarga del set de pruebas y CAF de certificación.
3. Construcción y envío de los XML exigidos.
4. Corrección hasta obtener recepción consistente con el set.
5. Muestras de representación y sitio de consulta cuando sean requeridos.
6. Declaración de cumplimiento.
7. Autorización para producción.

El SII indica un tiempo de revisión de 10 a 15 días hábiles para la revisión de boletas, no para todo el desarrollo. Una cuenta de certificación puede eliminarse tras seis meses sin actividad.

Fuentes: [guía vigente para certificar boletas](https://www.sii.cl/servicios_online/1039-guia_emitir_boleta_servicio-1184.html) y [proceso de certificación DTE](https://www.sii.cl/factura_electronica/factura_mercado/proceso_certificacion.htm).

### Migración desde otro sistema

- Cambiar de proveedor comercial no obliga necesariamente a postular o certificar todo nuevamente; el SII recomienda ejecutar pruebas en certificación.
- Pasar de software comercial a desarrollo propio no requiere una nueva postulación del contribuyente, pero sí probar/certificar los documentos o cambios que correspondan.
- Pasar desde el sistema gratuito de boletas del SII a uno propio o de mercado puede exigir una presentación mediante Formulario 2117 y una habilitación paralela.

Sabemos que el Point vigente imprime boletas electrónicas bajo el RUT de la panadería y que el Point nuevo no usa Mercado Pago Boletas ni está asociado todavía al comercio. Aún debe determinarse qué proveedor o autorización sostiene el emisor vigente, quién controla sus CAF, documentos y certificado, cuál es el modelo declarado, y bajo qué RUT reportaría operaciones el Point nuevo una vez asociado.

La migración se tratará como un corte desde el **sistema tributario vigente** hacia el motor SII propio de `stock-app`, manteniendo el **Point nuevo** como frontera de pagos separada. No se supondrá que el proveedor tributario vigente es Mercado Pago sólo porque la representación haya sido impresa por un dispositivo Point.

Fuentes: [cambio de proveedor](https://www.sii.cl/preguntas_frecuentes/factura_electronica/001_003_6485.htm), [cambio de comercial a propio](https://www.sii.cl/preguntas_frecuentes/factura_electronica/001_003_6529.htm) y [cambio desde sistema gratuito](https://www.sii.cl/preguntas_frecuentes/bol_electr_vtas_serv/001_380_7816.htm).

## 7. Evaluación de las fuentes entregadas

### `JavierAgueroCL/laravel-dte-api`

Conclusión: referencia histórica útil; no usar como base desplegable.

- Licencia MIT.
- Mapea varios DTE, CAF, envíos, estados, PDF y validación XSD.
- Usa Laravel 6/PHP 7.4, sin README, CI ni pruebas tributarias suficientes; los últimos cambios funcionales son de 2023.
- Guarda contraseña PFX como campo serializable y material privado en almacenamiento general.
- Un controlador de certificados puede exponer datos sin comprobar correctamente la pertenencia a la empresa.
- Desactiva verificación TLS al hablar con el SII.
- Su asignación de folios es lectura-modificación-escritura sin bloqueo ni unicidad, por lo que puede duplicar folios bajo concurrencia.

Uso permitido: estudiar el dominio y construir fixtures independientes. No copiar sus patrones de seguridad, transporte, autenticación o persistencia.

Repositorio: [laravel-dte-api](https://github.com/JavierAgueroCL/laravel-dte-api).

### `devlas-cl/dte-sii`

Conclusión: candidato técnico para un experimento controlado detrás de un adaptador; no dependencia confiable directa en producción.

- Es Node 18+, MIT y es el proyecto más cercano al stack actual.
- Incluye piezas para PFX, CAF, TED, XML, sobres, envío, consultas y certificación.
- Es muy reciente: comenzó en marzo de 2026, tiene un mantenedor, no tiene releases estables ni CI y las pruebas publicadas cubren principalmente extracción de RUT desde PFX.
- README, tipos TypeScript y API ejecutable no están completamente sincronizados.
- Deshabilita TLS globalmente y habilita renegociación insegura.
- Contiene RUT y contraseña PFX hardcodeados en una prueba.
- Persiste cookies del SII y folios en JSON; el registro de folios no es atómico ni multiproceso.
- El modo debug puede escribir XML y respuestas con información tributaria/personal.
- No hay evidencia reproducible en el repositorio de una certificación completa aceptada por el SII.
- Presenta el RVD como flujo productivo normal, lo que está obsoleto desde agosto de 2022.

Uso permitido: hacer un fork fijado a commit, ponerlo detrás de una interfaz propia, eliminar TLS inseguro y persistencia sensible, reemplazar el registro JSON por PostgreSQL y demostrar cada función contra XSD y certificación. La aplicación debe poder reemplazarlo sin cambiar el dominio.

Repositorio: [dte-sii](https://github.com/devlas-cl/dte-sii).

### `sebaiturravaldes/eboleta-sii`

Conclusión: no usar.

- Automatiza con Puppeteer el portal gratuito `eboleta.sii.cl` usando RUT y clave tributaria.
- No implementa DTE, CAF, firma ni la API oficial.
- Depende de selectores CSS y esperas fijas; no tiene idempotencia, reintentos, pruebas ni CI.
- Tiene cuatro commits y no incluye un archivo de licencia, aunque `package.json` declara ISC.
- El SII indica expresamente que su sistema gratuito no se integra con aplicaciones del contribuyente. Automatizar la interfaz es frágil y puede contradecir las condiciones del sitio.

Repositorio: [eboleta-sii](https://github.com/sebaiturravaldes/eboleta-sii).

### `FacTronica/BoletaHonorariosEmitir`

Conclusión: irrelevante para este proyecto y con patrones inseguros.

- Trata boletas de honorarios electrónicas, no boletas de ventas y servicios 39/41.
- No contiene motor: sólo un README comercial y ejemplos.
- El endpoint mostrado es un placeholder; no existe especificación, código verificable ni pruebas.
- El ejemplo usa HTTP, `curl -k` y envía clave SII/certificado/clave privada en el payload.
- No tiene licencia.

Repositorio: [BoletaHonorariosEmitir](https://github.com/FacTronica/BoletaHonorariosEmitir).

### Hilo de Reddit

Conclusión: útil como lista de tropiezos, no como fuente técnica, económica ni tributaria.

- El error `LSX-00204` confirma que orden de nodos, esquema, sobre y encoding son estrictos.
- La sugerencia de certificar gratis con Facto y luego "cambiar correos" simplifica una migración que requiere respaldo, folios, pruebas, coordinación y cierre del proveedor.
- El bloqueo relatado con RVD mezcla un artefacto que puede aparecer en certificación con una obligación productiva eliminada en 2022.
- Los relatos de éxito en JS/PHP no incluyen fixtures, Track ID, estados aceptados o pruebas reproducibles.

Hilo: [Certificación al SII mediante SimpleAPI](https://www.reddit.com/r/chileIT/comments/1pmhkuv/certificacion_al_sii_mediante_simpleapi/).

## 8. Encaje con la aplicación actual

`stock-app` ya tiene una buena base para integrar el dominio tributario:

- Node 20, Express 5 y PostgreSQL.
- Ventas en efectivo quedan pagadas dentro de una transacción.
- Ventas con tarjeta reservan inventario y sólo pasan a pagadas tras estado `processed/accredited` de Mercado Pago.
- Webhook y polling convergen sobre la misma venta.
- Reembolsos, reposición de inventario y notas de crédito ya son conceptos separados.

El flujo Mercado Pago observado en el código corresponde al Point nuevo que se pretende integrar con `stock-app`; no representa ni controla necesariamente el flujo tributario del terminal vigente fotografiado. Actualmente:

- la integración se considera configurada con `MERCADOPAGO_ACCESS_TOKEN` y `MERCADOPAGO_POINT_TERMINAL_ID`, pero no valida el titular/collector ni un RUT esperado;
- la consulta del terminal obtiene `storeId`, `posId` y modo operativo, pero no los compara con una configuración esperada y verificada;
- el código no consume Mercado Pago Boletas;
- las órdenes se crean con `print_on_terminal: 'no_ticket'`, por lo que el flujo actual no entrega por sí mismo el voucher o DTE en la impresora del Point.

Gaps actuales:

- `tax_documents` sólo soporta `credit_note` y estados `pending/issued/failed`.
- No existe boleta 39/41, evidencia de voucher, snapshot de política tributaria ni vínculo genérico venta-DTE.
- No hay tabla de emisor, sucursal, certificado, CAF, rangos de folio, sobres, eventos o outbox.
- No hay worker duradero ni reconciliador SII.
- El modo JSON local no ofrece concurrencia ni durabilidad suficientes para folios de producción.
- No existe representación de boleta, entrega digital, consulta pública ni retención de XML.
- No existe verificación fail-closed de que Access Token, collector, terminal, tienda, POS, titular y RUT pertenezcan al mismo comercio ni de que las liquidaciones lleguen a la cuenta esperada.
- No existe hoy un flujo de tarjeta externa/manual: si el Point nuevo no se asocia a la cuenta que controla `stock-app`, la aplicación tampoco podrá recibir sus órdenes/webhooks, conciliarlas o reembolsarlas.

El flujo de caja/tarjeta no debe reescribirse. La integración se agrega después del hecho de negocio `sale.paid` y conserva estados separados para pago, inventario y tributación.

### Impresión en el Point nuevo

Mercado Pago publica una Printing API para imprimir imágenes, comprobantes personalizados y DTE en dispositivos Point Smart. Esto hace **plausible**, pero no demostrada, la entrega de la representación propia desde el mismo terminal. Antes de elegirla se debe ejecutar un spike con el modelo físico y las credenciales reales para comprobar acceso al endpoint, formato admitido, resolución, colas, errores, reimpresión, rendimiento y comportamiento sin conectividad.

El campo actual `print_on_terminal: 'no_ticket'` de Orders API no imprime el DTE propio. La arquitectura debe conservar un fallback probado —impresora externa o entrega virtual autorizada— si Printing API no está disponible o no cumple el tiempo operacional.

Fuentes: [configuración oficial de terminal Point](https://www.mercadopago.cl/developers/es/docs/mp-point/configure-terminal), [Printing API para dispositivos Point](https://www.mercadopago.cl/developers/es/news/2025/04/09/New-Printing-API-for-Point-Devices) y [visión general de Point](https://www.mercadopago.cl/developers/es/docs/mp-point/overview).

## 9. Arquitectura objetivo

La primera versión debe ser un límite lógico dentro del repositorio y un proceso worker separado, compartiendo PostgreSQL. No hace falta introducir Redis ni un microservicio remoto mientras un outbox transaccional en PostgreSQL cubra el volumen.

```text
POS / webhook Mercado Pago
          |
          v
transacción PostgreSQL
  - venta pagada
  - snapshot de líneas/precios/impuestos
  - resolución de evidencia tributaria
  - evento tax_outbox si corresponde DTE
          |
          v
worker tributario aislado
  - reserva transaccional de folio/CAF
  - XML + TED + XMLDSIG + XSD
  - persistencia de XML y hash inmutables
          |                         |
          v                         v
representación y entrega       token y envío SII
  - inmediata al firmar            |
  - impresión/canal virtual         v
  - consulta y conservación     reconciliador SII
                                - recibido / aceptado / observado / rechazado
                                - retry con el mismo documento
                                - alerta y revisión manual
```

### Componentes

1. `TaxPolicyResolver`: decide `verified_electronic_voucher`, `sii_dte_39`, `sii_dte_41` o `manual_review` a partir del emisor, modelo declarado, medio/proveedor de pago y elegibilidad verificada de la cuenta/terminal. Nunca promueve un recibo financiero a voucher sólo por ser tarjeta/QR.
2. `TaxOutbox`: crea un trabajo en la misma transacción que deja la venta pagada.
3. `FolioAllocator`: importa CAF, verifica firma/rango/vigencia y reserva folios con bloqueo de fila y restricción única.
4. `DteBuilder`: crea un snapshot inmutable y genera XML determinista.
5. `DteSigner`: firma TED, DTE y sobre sin exponer claves.
6. `SiiBoletaGateway`: semilla, token, upload y consultas para 39/41.
7. `SiiDteGateway`: transporte separado para DTE 61 y otros DTE futuros.
8. `TaxReconciler`: consulta estados, clasifica respuestas y decide retry o revisión.
9. `ReceiptRenderer`: representación impresa/virtual construida desde el snapshot, nunca desde el catálogo mutable. No espera el estado final SII para representar un DTE localmente válido y firmado.
10. `ReceiptDelivery`: impresión, correo u otro canal autorizado con estados propios y un objetivo operacional de entrega inmediata.
11. `TaxAdmin`: estado de CAF/certificado, documentos rechazados, reintentos y acciones manuales auditadas.
12. `PaymentTerminalVerifier`: comprueba en forma fail-closed que collector, cuenta, terminal, tienda, POS, modo operativo, titular/RUT esperado y destino de liquidaciones corresponden a la configuración aprobada.

### Tablas mínimas

Los nombres finales deben seguir las convenciones del repositorio, pero el modelo necesita al menos:

- `issuer_configs`: RUT, razón social, giro, ambiente, modelo voucher/boleta, zona horaria y configuración de sucursal.
- `payment_processor_accounts`: proveedor, merchant/collector ID, titular y RUT esperado, referencia de cuenta receptora minimizada, estado, evidencia y fecha de verificación.
- `payment_terminals`: identificador/serial minimizado, cuenta procesadora, tienda, POS, modo, sucursal, rol `legacy` o `stock_app`, estado y fecha de verificación.
- `issuer_signers`: metadatos del certificado, referencia cifrada, vigencia y estado; nunca PFX/clave en claro.
- `caf_ranges`: tipo DTE, rango, XML CAF cifrado, huella, siguiente candidato y estado.
- `folio_allocations`: emisor, tipo, folio, CAF, documento y timestamps; único por `(issuer_id, dte_type, folio)`.
- `tax_documents`: venta/reembolso, tipo 39/41/61, folio, snapshot, hash XML y estado SII.
- `tax_document_events`: historial append-only de construcción, firma, envío, respuesta, consulta y acción manual.
- `tax_submissions`: sobre, hash, documentos incluidos, Track ID y respuestas sanitizadas.
- `tax_submission_documents`: relación entre cada sobre/envío y sus DTE; no asumir que un Track ID identifica exactamente un documento.
- `tax_outbox`: idempotency key, intento, próximo intento, lease y error clasificado.
- `tax_deliveries`: canal, destinatario cifrado o minimizado, estado e intentos.
- `sale_payment_evidence`: recibo financiero, order/payment ID, cuenta, terminal/tienda/POS, estado y snapshot de conciliación; no implica validez tributaria.
- `sale_tax_evidence`: `verified_electronic_voucher`, `sii_dte` o `legacy_sii_dte`, emisor, identificadores y snapshot de la política y verificación aplicadas.

Restricciones mínimas:

- único `(issuer_id, dte_type, folio)`;
- único `idempotency_key` de emisión, por ejemplo `sale:{sale_id}:primary`;
- una evidencia tributaria primaria por venta bajo la política seleccionada;
- una nota de crédito no puede referenciar un documento inexistente o de otro emisor;
- montos y líneas del DTE se guardan como snapshot inmutable.

### Estados separados

No usar un único `issued` para todo el ciclo. Como mínimo:

- pago: `pending`, `paid`, `failed`, `refunded`;
- documento: `not_required`, `queued`, `folio_reserved`, `built`, `signed`, `submitted`, `received`, `accepted`, `accepted_with_observations`, `rejected`, `retryable`, `manual_review`;
- entrega: `pending`, `printed`, `sent`, `failed`;
- reembolso: estado de Mercado Pago o caja;
- nota de crédito: ciclo DTE independiente.

## 10. Reglas de consistencia e idempotencia

1. Sólo una venta final pagada puede producir evidencia tributaria.
2. Efectivo: venta, snapshot tributario y outbox se crean en la misma transacción PostgreSQL.
3. Tarjeta: el webhook/polling sólo crea evidencia después de `processed + accredited`.
4. En modo voucher, tarjeta/QR omite DTE 39/41 sólo si cuenta, terminal, RUT emisor, reporte del adquirente, entrega del comprobante y modelo SII están verificados; entonces registra `verified_electronic_voucher`. En cualquier discrepancia queda en `manual_review` y se bloquea el uso productivo del terminal.
5. En modo siempre-boleta, tarjeta/QR encola DTE sólo después del pago acreditado y conserva el comprobante Point como evidencia financiera. Emitir un DTE propio no regulariza una cuenta de pagos ajena.
6. Worker y webhook pueden ejecutarse varias veces sin crear un segundo documento.
7. La reserva del folio ocurre dentro de una transacción con `SELECT ... FOR UPDATE` o bloqueo equivalente.
8. Un folio reservado nunca vuelve al pool por un timeout o rechazo.
9. Después de firmar, XML, identidad `(RUT, tipo, folio)` y hash son inmutables.
10. Si el upload tiene resultado incierto, consultar estado y reenviar exactamente el mismo XML según la política documentada; nunca asignar otro folio a ciegas.
11. HTTP 200 y Track ID no significan aceptación.
12. Los retries usan backoff con jitter, límite temporal y paso a revisión manual.
13. Alertar con margen antes del máximo de una hora, agotamiento de CAF y vencimiento del certificado.
14. Reconciliar periódicamente documentos locales, estados SII y Registro de Compras y Ventas.
15. Generar y poner a disposición la representación inmediatamente después de obtener el DTE firmado; no esperar la consulta final SII. Si la generación local falla, el POS debe mostrar una contingencia explícita y alertar al responsable, nunca ocultar el problema.
16. La consulta pública con CAPTCHA es sólo una verificación humana complementaria. Los workers usan los endpoints oficiales de estado; nunca automatizan la interfaz web.

## 11. Seguridad no negociable

- El PFX, su contraseña, la clave privada del certificado y la clave privada del CAF nunca llegan al navegador.
- No almacenar secretos en Git, logs, JSON local, snapshots de error ni columnas en claro.
- Cifrar material en reposo con una clave separada de la base de datos; descifrar sólo en memoria del worker durante el menor tiempo posible.
- Mantener validación TLS. Prohibido `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized: false`, `curl -k` o equivalentes.
- No usar RUT y clave tributaria para automatizar el portal web.
- Sanitizar XML/respuestas en logs; los artefactos completos van a almacenamiento cifrado con control de acceso y retención definida.
- Validar pertenencia de emisor en cada consulta y mutación. Si algún día hay varios RUT, toda tabla y clave debe estar aislada por `organization_id`/`issuer_id`.
- Verificar vigencia, RUT y cadena del certificado antes de firmar; alertar a 60, 30, 15 y 7 días del vencimiento.
- Auditar carga/reemplazo de certificado, importación/anulación de CAF, retry manual, cambio de estado y descarga de XML.
- Fijar versiones/commits de librerías tributarias y someter cambios a fixtures y certificación antes de actualizar.

## 12. Plan futuro por fases

### Fase 0: auditoría tributaria y decisión de producto

No escribir integración productiva hasta responder y respaldar:

- RUT y razón social exactos del emisor.
- Inventario separado del Point vigente y el Point nuevo: rol, modelo/serial, terminal ID, propietario, cuenta/collector Mercado Pago, aplicación, tienda, POS, modo operativo, cuenta receptora de liquidaciones y responsable de acceso.
- Evidencia sanitizada de que el Access Token, collector, terminal, tienda y POS del Point nuevo pertenecen a la cuenta autorizada de la panadería. Si pertenece o liquida a un tercero, detener la salida a producción.
- Estado del sistema tributario vigente: proveedor real, contrato/plan, cuenta administradora, certificado, CAF, último folio confirmado y rangos activos. La muestra observada no se usa como último folio.
- Estado de Mercado Pago Boletas en cada cuenta; no asumir que existe una suscripción que cancelar.
- Resoluciones/autorizaciones y tipos DTE habilitados.
- Modelo voucher/boleta declarado hoy.
- Confirmación de bajo qué RUT reportaría el adquirente los vouchers del Point nuevo y cómo aparecerían en la información tributaria/RCV.
- Volumen diario/mensual por efectivo, transferencia, tarjeta y QR.
- Existencia de operaciones exentas y validación de tipo 41.
- Firmantes autorizados y certificado digital vigente.
- Sucursales, códigos SII, cajas y direcciones de origen.
- CAF existentes, folios usados/no usados y quién los controla.
- Proceso actual para anulaciones, cambios, devoluciones y notas de crédito.
- Impresora disponible y canales aceptados para entrega virtual.
- Capacidad real de imprimir una representación propia en el Point nuevo; `no_ticket` no cuenta como solución de entrega.
- Intención real: un RUT o plataforma multiempresa.

Entregable: acta de decisión firmada por dueño/contador que seleccione una de estas políticas:

- A: voucher previamente verificado + e-Boleta SII manual;
- B: voucher previamente verificado + DTE propio sólo para efectivo/transferencia;
- C: DTE propio para todos los medios bajo "Siempre emito boleta", preferida si el objetivo es independencia del emisor Point;
- D: conservar proveedor administrado.

Gate: no avanzar si el modelo declarado y las autorizaciones no son verificables. El Point nuevo no procesa ventas reales si cuenta, titular/RUT, terminal, tienda/POS y destino de liquidación no coinciden con la panadería. La ruta A/B tampoco avanza sin demostrar que su voucher es reportado por el operador bajo el RUT y modelo correctos.

### Fase 1: spike técnico en certificación

- Crear una interfaz interna independiente de proveedor.
- Evaluar un fork de `dte-sii` fijado a commit versus implementación mínima desde esquemas oficiales.
- Corregir TLS, secretos, logs y registro de folios antes de ejecutar la librería.
- Importar sólo CAF de certificación.
- Construir una boleta 39 mínima y otra con varias líneas, acentos, descuentos y redondeos.
- Validar XSD, TED y todas las firmas con verificadores independientes.
- Obtener semilla/token, enviar a certificación y llegar a estado final aceptado.
- Guardar fixtures sin secretos y respuestas sanitizadas.
- Ejecutar un spike independiente de Printing API con el Point físico; demostrar impresión, reimpresión, errores y fallback, o descartar esa vía y seleccionar impresora externa/entrega virtual.

Gate: evidencia reproducible de aceptación en certificación, sin desactivar seguridad.

### Fase 2: motor durable y certificación completa

- Añadir migraciones PostgreSQL, outbox, folios transaccionales y estados append-only.
- Implementar 39; implementar 41 sólo si está autorizado y realmente se necesita.
- Resolver 61 mediante el flujo DTE general o probar una alternativa manual oficial.
- Completar el set vigente, incluyendo RCF sólo si el set de certificación lo pide.
- Crear representaciones, entrega y página de consulta conforme a requisitos asignados.
- Completar muestras, revisión y declaración de cumplimiento.

Gate: autorización SII y camino probado para correcciones/anulaciones.

### Fase 3: integración con `stock-app`

- Conectar el outbox al momento exacto en que `sales.status` pasa a `paid`.
- Validar al inicio y periódicamente que la identidad del collector, terminal, tienda, POS y modo obtenidos desde Mercado Pago coincidan con la configuración aprobada; fallar cerrado ante discrepancias.
- Registrar primero el comprobante del Point nuevo como evidencia financiera. Promoverlo a `verified_electronic_voucher` sólo bajo el modelo híbrido y después de que Fase 0 haya demostrado su elegibilidad tributaria.
- Añadir UI operativa que no espere la aceptación final del SII, pero sí mantenga visible el flujo hasta entregar la representación firmada o activar una contingencia explícita.
- Añadir entrega impresa/virtual y reenvío.
- Incorporar alertas por una hora, certificado, CAF, rechazo y cola detenida.
- Mantener el modo JSON exclusivamente para demo; impedir emisión SII real sin PostgreSQL.

Gate: suite completa, simulacro de caída SII y reconciliación contable aprobada.

### Fase 4: migración controlada

- Exportar y respaldar XML, reportes, folios y estados del sistema tributario asociado al Point vigente antes de darlo de baja.
- Probar en certificación sin emitir duplicados en producción.
- Solicitar un rango CAF nuevo para el sistema propio o reconciliar formalmente cualquier rango existente.
- No permitir que dos sistemas asignen folios del mismo rango.
- Definir fecha/hora de corte, último documento del sistema anterior y primer documento propio.
- Actualizar modelo de emisión, proveedor, correos y usuarios en SII cuando corresponda.
- Dar de baja el sistema tributario vigente sólo después de identificar el servicio exacto, verificar el primer ciclo propio y asegurar la recuperación histórica. Cancelar o revocar Mercado Pago Boletas únicamente si la auditoría confirma que está activo.
- Mantener explícitamente separadas durante el corte estas fronteras: sistema tributario del Point vigente, motor SII propio de `stock-app` y Point nuevo como procesador de pagos.
- Reconciliar diariamente durante las primeras semanas: ventas, vouchers, DTE, notas, Track ID y RCV.
- Mantener un plan de reversión operativo; nunca "revertir" reutilizando folios ya asignados.

Gate: conciliación sin omisiones ni duplicidad y aceptación del contador.

## 13. Matriz mínima de pruebas

### Unitarias

- RUT/DV, fechas y zona horaria `America/Santiago`.
- Cálculo neto, IVA, total y redondeo en CLP.
- Fixture anonimizado observado: total `2200 = 1849 neto + 351 IVA`, sin copiar RUT ni folio.
- Líneas, descuentos, recargos y caracteres acentuados.
- DTE 39 y, si aplica, 41.
- TED y XMLDSIG con fixtures verificables.
- XSD vigente y orden estricto de elementos.
- CAF válido, fuera de rango, agotado, duplicado y corrupto.
- Certificado correcto, expirado, RUT incorrecto y contraseña errónea.
- Clasificación de todos los estados y errores SII conocidos.

### Concurrencia e idempotencia

- Múltiples workers reservan folios distintos.
- Webhook duplicado no crea dos DTE.
- Polling y webhook simultáneos convergen.
- Timeout después de upload no asigna otro folio.
- Reinicio entre reserva, firma, upload y consulta recupera el mismo trabajo.
- Reintento manual no modifica el XML ya firmado.

### Integración

- Semilla expirada y token expirado.
- Respuesta HTTP 200 seguida de rechazo tributario.
- Resultado público "Documento Recibido por el SII" y Track ID se conservan como recepción, sin promover el documento a `accepted`.
- Sobre aceptado con un documento rechazado.
- SII lento/no disponible por más de un intento.
- Certificación para 39 y flujo 61.
- Entrega impresa y virtual.
- Printing API del Point: éxito, cola, reimpresión, terminal desconectado, formato inválido y fallback externo/virtual.

### Negocio

- Efectivo genera exactamente una boleta.
- Transferencia genera exactamente una boleta.
- Tarjeta bajo modelo voucher no genera DTE.
- Tarjeta sólo se clasifica como voucher si cuenta, terminal, RUT, reporte y modelo están verificados; un recibo financiero sin esa evidencia pasa a revisión.
- Tarjeta bajo modelo siempre-boleta genera exactamente un DTE después de acreditarse.
- Pago fallido/cancelado no genera evidencia de venta.
- Reembolso de voucher no inventa un folio DTE.
- Devolución de boleta propia crea o exige nota 61 sin alterar inventario dos veces.
- Reportes separan ventas, reembolsos, vouchers y DTE sin duplicar ingresos.
- Collector/terminal/tienda/POS o destino de liquidación incorrectos bloquean el Point nuevo antes de cobrar.

### Seguridad

- Ningún secreto o XML completo aparece en logs y respuestas API.
- TLS inválido falla de forma cerrada.
- Un emisor no accede a certificados, CAF, folios o documentos de otro.
- Backups cifrados se restauran y conservan la trazabilidad.

## 14. Criterios de no salida a producción

No desplegar si ocurre cualquiera de estos puntos:

- modelo voucher/boleta no confirmado en el SII;
- Point nuevo sin asociación demostrada a la cuenta, collector, titular/RUT, tienda/POS y liquidación de la panadería;
- comprobante Point clasificado como voucher tributario sólo por ser un pago acreditado, sin prueba de reporte bajo el RUT/modelo correctos;
- ausencia de autorización/certificación aplicable;
- certificado o CAF almacenados en claro;
- validación TLS desactivada;
- folios gestionados en archivo JSON o sin restricción única;
- un único estado ambiguo `issued` que confunda documento generado, enviado y aceptado, o cualquier mensaje que afirme aceptación SII antes de verificarla;
- no existe solución probada para nota 61 o procedimiento manual oficial;
- no existe entrega al comprador;
- la estrategia depende de imprimir en el Point, pero Printing API no fue probada y no existe fallback;
- no hay alertas para el plazo de una hora, CAF y certificado;
- no hay reconciliación con Mercado Pago y RCV;
- dos emisores pueden operar el mismo rango de folios;
- sólo se ha probado el camino feliz.

## 15. Fuentes principales

### SII

- [Portal voucher/boleta y modelos de emisión](https://www.sii.cl/destacados/boleta_electronica_voucher/index.html)
- [OpenAPI oficial de boletas](https://www4c.sii.cl/bolcoreinternetui/api/openapi.json)
- [Formato de boleta electrónica v4.2](https://www.sii.cl/factura_electronica/factura_mercado/formato_boleta_electronica.pdf)
- [Formatos XML y esquemas](https://www.sii.cl/servicios_online/1039-formato_xml-1184.html)
- [Instructivo API de boleta](https://www.sii.cl/factura_electronica/factura_mercado/Instructivo_Emision_Boleta_Elect.pdf)
- [Guía de certificación de boleta](https://www.sii.cl/servicios_online/1039-guia_emitir_boleta_servicio-1184.html)
- [Proceso de certificación DTE](https://www.sii.cl/factura_electronica/factura_mercado/proceso_certificacion.htm)
- [Resolución 74/2020: emisión, envío, CAF y conservación](https://www.sii.cl/normativa_legislacion/resoluciones/2020/reso74.pdf)
- [Resolución 53/2022: eliminación RVD](https://www.sii.cl/normativa_legislacion/resoluciones/2022/reso53.pdf)
- [FAQ RVD actualizada 2026-07-20](https://www.sii.cl/preguntas_frecuentes/bol_electr_vtas_serv/001_380_7679.htm)
- [Resolución 53/2025: entrega impresa/virtual](https://www.sii.cl/normativa_legislacion/resoluciones/2025/reso53.pdf)
- [Resolución 207/2025: TED opcional en representación impresa](https://www.sii.cl/normativa_legislacion/resoluciones/2025/reso207.pdf)
- [Cambio de proveedor](https://www.sii.cl/preguntas_frecuentes/factura_electronica/001_003_6485.htm)
- [Cambio a software propio](https://www.sii.cl/preguntas_frecuentes/factura_electronica/001_003_6529.htm)
- [Cambio desde e-Boleta gratuita](https://www.sii.cl/preguntas_frecuentes/bol_electr_vtas_serv/001_380_7816.htm)
- [Requisitos para proveedor de boleta electrónica](https://www.sii.cl/servicios_online/3785-.html)

### Proveedores y repositorios

- [Mercado Pago Boletas](https://www.mercadopago.cl/mp/boletas-electronicas)
- [Mercado Pago Point Smart 2](https://www.mercadopago.cl/herramientas-para-vender/lectores-point/point-smart-2)
- [Configuración y asociación de terminal Point](https://www.mercadopago.cl/developers/es/docs/mp-point/configure-terminal)
- [Cuenta/collector que recibe las ventas de una tienda](https://www.mercadopago.cl/developers/es/reference/in-person-payments/point/stores/create-store/post)
- [Orders API y validación de propietario del terminal](https://www.mercadopago.cl/developers/es/reference/in-person-payments/point/orders/create-order/post)
- [Printing API para dispositivos Point](https://www.mercadopago.cl/developers/es/news/2025/04/09/New-Printing-API-for-Point-Devices)
- [SimpleAPI](https://www.simpleapi.cl/)
- [SimpleAPI precios](https://www.simpleapi.cl/Precios)
- [Facto](https://facto.cl/)
- [Facto precios](https://facto.cl/precios/)
- [laravel-dte-api](https://github.com/JavierAgueroCL/laravel-dte-api)
- [dte-sii](https://github.com/devlas-cl/dte-sii)
- [eboleta-sii](https://github.com/sebaiturravaldes/eboleta-sii)
- [BoletaHonorariosEmitir](https://github.com/FacTronica/BoletaHonorariosEmitir)
- [Hilo Reddit analizado](https://www.reddit.com/r/chileIT/comments/1pmhkuv/certificacion_al_sii_mediante_simpleapi/)

## 16. Decisión final propuesta

Para Atelier del Puerto hoy:

1. Mantener temporalmente el sistema tributario del Point vigente; la evidencia confirma recepción SII de una boleta real, no autoriza un corte improvisado.
2. Auditar los dos terminales y confirmar cuenta/collector, titular, RUT, tienda/POS, destino de liquidaciones, proveedor tributario vigente, CAF y modelo declarado.
3. Asociar correctamente el Point nuevo antes de cualquier venta real. La integración directa SII no puede corregir un terminal o una cuenta de cobro ajenos.
4. Si se busca independencia del emisor Point, preferir DTE propio para todos los medios bajo "Siempre emito boleta". Usar el modelo híbrido sólo si la elegibilidad tributaria del voucher nuevo queda demostrada.
5. Identificar el servicio vigente y confirmar una mensualidad real antes de presentar el proyecto como ahorro o cancelar algo.
6. Si se aprueba el desarrollo, comenzar en certificación, probar la entrega —incluida Printing API o su fallback— y ejecutar un cutover con rangos, XML y estados reconciliados.

La respuesta técnica sigue siendo **sí se puede**. Con la evidencia nueva, el problema inmediato no es cancelar Mercado Pago Boletas en el Point nuevo —no está activo—, sino separar y regularizar los dos terminales, descubrir el emisor vigente y diseñar una migración sin omisiones, doble tributación ni pagos liquidados a la cuenta equivocada.

## 17. Referencias de implementación evaluadas

Estas notas proceden del resumen de investigación del 2026-08-05 y conservan su contexto histórico; las licencias y el estado de los proyectos deben revisarse antes de incorporar código.


### LibreDTE

[LibreDTE Core](https://github.com/LibreDTE/libredte-lib-core) is the most substantial implementation reviewed: PHP, extensive DTE scope, tests, signing, and SII integration. It is useful as a behavior and architecture reference.

It is licensed under AGPL-3.0 and its repository explicitly states that software using it must publish its source under AGPL. That conflicts with a future proprietary POS unless we deliberately adopt that licensing model. We should not copy or embed it casually.

### sii-chile-cert

[sii-chile-cert](https://github.com/dbenaventep/sii-chile-cert) is an MIT-licensed Python guide and test-oriented implementation covering certification experience, DTE types including 39 and 61, examples, schemas, and known library patches. It is useful for certification fixtures and independent validation, but its small history means it should not become the production tax engine without a security and correctness audit.

### Recommendation

Use the official SII schemas and instructions as the source of truth. Use open-source projects to build test vectors and understand edge cases. Implement our production boundary with explicit tests and keep the option to replace the internal engine without changing the POS.

