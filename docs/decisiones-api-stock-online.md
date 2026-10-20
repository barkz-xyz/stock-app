# Recomendaciones para la API de stock y las ventas online

Propuesta del 20 de octubre de 2026 para resolver las cinco decisiones pendientes del [plan de integración](api-stock-ventas-online.md). Arquitectura acordada: Bakery POS y la futura tienda usarán repos y despliegues separados. Se implementa primero la [API de inventario de sólo lectura](inventory-api.md); pagos y pedidos online quedan en el checkout. Las reglas comerciales siguientes siguen propuestas.

## Opciones recomendadas

| Decisión | Recomendación inicial | Motivo |
| --- | --- | --- |
| Checkout, pagos y backend | Tienda y backend propios en otro repo; conexión con la API de Bakery POS | Separa la compra pública de la operación del local y conserva una única autoridad de inventario |
| Disponibilidad y entrega | Stock disponible del día, pago online y retiro en local | El inventario actual representa un saldo global, sin capacidad de producción por fecha |
| Catálogo, cantidades y precios | Publicar manualmente entre 10 y 15 productos con unidad confirmada y mantener el precio de Caja | Permite comprobar la operación con un catálogo pequeño y sin diferencias de precio entre canales |
| Reservas y pagos pendientes | Ventana de pago de 15 minutos y margen inicial de una unidad por producto del piloto | Evita carritos abandonados prolongados y deja un pequeño margen frente a diferencias de conteo |
| Devoluciones y contabilidad | Reembolso, reposición y documento tributario como operaciones separadas; conciliación web propia | Evita devolver stock no vendible o mezclar abonos online con efectivo y Point |

Los 15 minutos, el margen de una unidad y los tiempos de retiro son parámetros propuestos para el piloto. No describen reglas que ya estén activas.

## Checkout y responsabilidad del backend

Usar una tienda pública y su backend en otro repo y despliegue, conectados con Bakery POS por API. La tienda no accederá directamente a las tablas de inventario. Mantener la API independiente de cualquier plataforma comercial. Las credenciales de integración y pagos permanecen en el backend consumidor; los compradores no usan cuentas del personal.

La elección entre Checkout Pro y Checkout API con Bricks corresponde al futuro repo. Pro reduce el trabajo inicial de interfaz de pago; API con Bricks permite una experiencia integrada con más control visual. La decisión queda abierta hasta definir la tienda. Point conserva su integración presencial en Bakery POS.

El adaptador del proveedor online, las notificaciones y la reconciliación de pagos vivirán en la tienda. Las futuras reservas de stock tendrán una referencia externa e interfaces idempotentes en Bakery POS; no requieren trasladar al POS todo el pedido, los datos del comprador ni las credenciales de pago online.

Cada repo tendrá sus controles de build y pruebas, con pruebas de compatibilidad del contrato entre ambos. El administrador del POS gestiona las claves y el inventario; la publicación, los horarios, las incidencias y las entregas web corresponden a la tienda. El cajero conserva su acceso a Caja. La integración técnica no depende de abrir una sesión presencial.

La compra como invitado pediría nombre y correo; teléfono sólo cuando sea necesario para coordinar el retiro. Para retirar en local no pediría domicilio. El cliente recibiría confirmación y un enlace privado para consultar su pedido. La ficha mostraría precio final, cantidad o peso, disponibilidad, retiro y contacto de la panadería. [Información exigible en comercio electrónico, SERNAC](https://www.sernac.cl/portal/618/w3-propertyvalue-20982.html).

Mercado Pago sigue siendo un candidato por continuidad operativa, sin afirmar que sea el más barato. Antes de activar pagos hay que verificar comisión online, impuestos sobre ella, plazo de abono y devoluciones. La API de inventario reutiliza los recursos actuales del POS; el checkout requerirá su propio despliegue y una evaluación de consumo.

## Venta del día y retiro

Empezar con productos ya disponibles para retirar el mismo día. Los encargos futuros requieren otro modelo: cupos de producción, anticipación, fecha comprometida y reservas por fecha. Descontarlos del saldo de hoy produciría una disponibilidad engañosa.

Como configuración de prueba propongo **30 minutos de preparación después del pago**, franjas de retiro de **30 minutos** y un máximo inicial de **dos pedidos por franja**, sujeto a la capacidad real del local. El cupo de retiro debe reservarse junto con los productos para evitar prometer más entregas de las que se pueden preparar.

Con una ventana de pago de 15 minutos, la franja elegible debe empezar al menos 45 minutos después de iniciar el checkout. Un pago confirmado más tarde exige volver a comprobar el horario antes de prometer la entrega. El sistema debe dejar de ofrecer compras cuando no quede una franja viable dentro del horario real. Usar America/Santiago para las reglas del negocio y UTC para guardar instantes.

El retiro sería gratuito durante el piloto. El reparto quedaría para una segunda fase, después de definir zonas, tarifa, responsable de entrega y condiciones de conservación. Un pedido pagado que no se retire pasaría a incidencia: no se libera como un carrito impagado ni se repone automáticamente si ya perdió su aptitud para la venta.

## Productos, unidades, precios y vencimiento

La **exportación de inventario** debe seguir incluyendo todo el catálogo activo, con agotados y productos no vendibles. La **tienda pública** sólo mostraría productos habilitados expresamente por el administrador. Exportar un producto no equivale a publicarlo.

Empezaría con 10 a 15 productos de retiro sencillo y venta inequívoca por unidad, por ejemplo berlines, donas, palmeritas o muffins, una vez confirmadas sus presentaciones reales. Dejaría fuera del piloto encargos personalizados y productos con variantes todavía sin definir, como CAFE/TE.

Hay una validación concreta pendiente: los **49 productos de [productos-precios.json](../assets/productos-precios.json) figuran como `pieces`**, incluidos PAN AMASADO, PAN DOBLADITA, PAN HALLULLA y PAN MILAGRITO. Es un dato del archivo de referencia; no prueba cómo se venden hoy ni el estado de la base de producción. Hay que confirmar pieza, paquete o kilo antes de publicarlos. No convertiría sus precios a kilos por deducción.

Para el piloto, cantidades enteras y paso de una unidad. Los productos por peso necesitarían definir unidad base, incremento mínimo y equivalencia con Caja antes de admitir decimales. Si el negocio adopta paquetes de peso fijo, deben compartir una conversión de inventario explícita; crear un saldo independiente del mismo pan duplicaría existencias.

Mantener inicialmente el precio final de Caja, sin recargos automáticos por canal. Confirmar que esos precios representan el precio final al consumidor y no sumar IVA otra vez por defecto. El servidor recalcularía el total antes de reservar; después conservaría el precio acordado durante la ventana de pago. Un cambio anterior a la reserva debe mostrarse al cliente para que acepte el nuevo total.

Cada producto publicado debe tener identidad estable, unidad, precio, fotografía fiel y condiciones de conservación verificadas. Ingredientes y alérgenos deben venir de la panadería, no inferirse del nombre o de una imagen. Las futuras importaciones deben actualizar o archivar productos conservando sus identificadores.

La fecha de vencimiento actual es opcional y no representa lotes. Recomiendo habilitar la disponibilidad web del día después de comprobar existencias y aptitud de venta; al cerrar, desactivar esa disponibilidad hasta la revisión siguiente. Una fecha vacía no significa que el alimento no venza. El plazo seguro de venta de cada producto debe definirlo el negocio según su elaboración y conservación.

## Reserva, aprobación del pago y margen de stock

Reservar al iniciar el pago, después de validar carrito y franja, durante una ventana inicial de **15 minutos**. Navegar o agregar productos al carrito no reservaría stock. El servidor marcaría el vencimiento y la interfaz mostraría el tiempo disponible.

Limitar el piloto a medios de pago online de confirmación normalmente rápida, verificando cuáles permite restringir Checkout Pro para esta cuenta. Dejar transferencias manuales, pagos offline y pago al retirar para otra fase. Incluso una tarjeta puede quedar en procesamiento o revisión: entregar sólo tras consultar el estado autorizado en el servidor. [Estados oficiales de Orders](https://www.mercadopago.cl/developers/es/docs/checkout-pro-orders/payment-management/status/order-status).

Al vencer los 15 minutos se deben detener nuevos intentos y reconciliar el pedido con el proveedor. **Un temporizador vencido o una respuesta perdida no prueban que el cobro haya fallado.** Liberar stock y cupo cuando se confirme el rechazo o la cancelación; mantenerlos retenidos si el resultado es ambiguo, con reintentos y alerta operativa después de cinco minutos de ambigüedad. Antes de lanzar, verificar que la expiración y cancelación del proveedor permitan esta política.

Las notificaciones de pago deben guardarse de forma duradera y procesarse sin duplicados, consultando después el pedido al proveedor. El regreso del navegador a la tienda no acredita un cobro. [Notificaciones oficiales](https://www.mercadopago.cl/developers/es/docs/checkout-pro-orders/notifications?scope=prod).

Si llega un pago aprobado después de liberar una reserva, intentar recuperar atómicamente productos y un horario todavía válido. Si ya no es posible, registrar una incidencia de pago recibido y gestionar el reembolso; no confirmar una entrega inexistente. La transición de estados en [store.js](../server/store.js) necesita cubrir ese caso antes de incorporar el canal.

Para productos del piloto vendidos por pieza, propongo un margen inicial de **una unidad**, ajustable por producto tras medir diferencias de conteo y ventas. Los productos únicos o de alto valor requieren revisar el margen individualmente. El margen protege frente a errores físicos; las transacciones compartidas entre Caja y web son las que impiden vender dos veces la última unidad.

Ejemplo: si el saldo operativo es 12 y el margen es 1, se ofrecen 11 por internet. El saldo actual ya descuenta operaciones Point pendientes; no hay que restarlas otra vez. Reservar y aprobar un mismo pedido tampoco debe descontar dos veces. Añadir límites a reservas simultáneas e intentos para evitar que una persona bloquee todo el catálogo.

## Devoluciones y conciliación

| Situación | Dinero | Inventario |
| --- | --- | --- |
| Cancelación sin pago confirmado | Comprobar o cancelar el intento de cobro | Liberar una sola vez cuando sea seguro |
| Cancelación pagada antes de entregar | Reembolso por el proveedor y registro de su estado | Reponer sólo si el producto sigue disponible y apto para vender |
| Devolución después de entregar | Resolver según el motivo y la política aplicable | Sin reposición automática de alimentos; revisión y merma cuando corresponda |
| Producto incorrecto, faltante o defectuoso | Gestionar solución, reposición o reembolso según corresponda | Registrar el movimiento físico real, separado de devolver el dinero |

El administrador autorizaría estas operaciones con motivo e historial. Un reembolso pendiente no puede duplicarse al reintentar, y su llegada al cliente depende también del banco. [Reembolsos y cancelaciones, Mercado Pago](https://www.mercadopago.cl/developers/es/docs/checkout-pro-orders/refunds-cancellations?scope=prod).

Para perecibles puede corresponder excluir el derecho a retracto bajo las condiciones legales. Esa exclusión debe comunicarse antes del pago, de forma destacada junto al precio y características, usando expresamente “derecho a retracto”; no elimina los derechos por productos defectuosos. Evitar una regla general de “sin devoluciones”. [Decreto 52, artículos 3, 4 y 6](https://www.bcn.cl/leychile/navegar?idNorma=1206144).

Registrar por separado importe de ventas web, impuestos según el documento, reembolsos, comisiones y abonos netos del proveedor. El abono bancario neto no es el precio de venta. Mantener conciliación por canal y consolidación en métricas del negocio; el dinero web no debe aumentar el efectivo esperado ni la conciliación del terminal Point de una sesión presencial. El cierre general por fecha actual necesita filtrar el canal antes de incorporar estas operaciones.

Mantener el modelo de emisión declarado ante el SII y confirmar con el contador cómo cubre los medios de pago web. **Boleta más voucher no implica por sí solo una duplicación:** el SII contempla expresamente un modelo que emite ambos. En el otro modelo, el voucher válido del operador puede respaldar el pago electrónico. No trasladar automáticamente a internet la configuración del terminal Point. Para automatizar boletas cuando corresponda, preferir un proveedor autorizado existente frente a construir ahora un emisor tributario propio. [Modelos de emisión del SII](https://www.sii.cl/destacados/boleta_electronica_voucher/index.html).

Si se emitió una boleta electrónica que deba anularse, corresponde una nota de crédito electrónica. Reembolsar por Mercado Pago no sustituye ese ajuste. Para operaciones respaldadas sólo por voucher, confirmar el procedimiento del operador y del SII sin inventar una nota contra una boleta inexistente. [Anulación de boleta electrónica, SII](https://www.sii.cl/preguntas_frecuentes/factura_electronica/001_003_5352.htm).

## Validaciones necesarias antes de activar ventas

1. **Catálogo:** confirmar pieza, paquete o kilo, elegir los productos del piloto y completar conservación y presentación.
2. **Operación:** confirmar horarios, tiempo real de preparación, capacidad de retiro y responsable de incidencias.
3. **Pagos:** comprobar medios habilitados, expiración, comisiones, abonos y devolución en la cuenta real.
4. **Tributación:** confirmar modelo declarado, documentación del pago web y procedimiento de ajustes con el contador.

Estas decisiones comerciales no bloquean la primera fase de lectura. El orden recomendado sigue siendo API de inventario de sólo lectura, validación de sincronización y, después, pedidos con reservas y pagos bajo las pruebas de aceptación del plan.
