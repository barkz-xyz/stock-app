# Fondo inicial, retiros y ventas sin stock

Implementación POS del 26-10-2026. La caja existente es una sesión por usuario; no se han introducido cajas físicas compartidas entre usuarios.

## Apertura

`/api/bootstrap` incluye `registerOpening` cuando el usuario no tiene sesión abierta. Sugiere el efectivo **contado** del último cierre de ese usuario, aunque hayan pasado varios días. La primera apertura sugiere cero. Se permite ajustar ese monto y añadir efectivo por separado. `opening_cash` guarda el total y `opening_extra_cash` el aporte; `opening_source_session_id` enlaza el cierre anterior.

Abrir dos veces recupera la sesión abierta sin sumar el aporte nuevamente. La apertura de la interfaz envía el UUID/revisión del cierre usado como referencia; si cambió, se rechaza con `OPENING_CHANGED` y se actualiza el formulario. Cambiar un cierre antiguo no reescribe las aperturas que ya se hicieron.

## Retiros y rendiciones

Sección `/caja/retiros`, disponible para cajeros y administradores. Un cajero ve sus propios retiros; el administrador puede revisar todos. Para retirar o recibir un vuelto se requiere una sesión abierta propia.

- Efectivo disponible = fondo inicial + ventas netas en efectivo de la sesión + vueltos recibidos - retiros emitidos. Point y reservas online no aumentan el efectivo disponible.
- Un retiro registra monto CLP entero, destinatario y motivo. No puede superar el saldo disponible.
- Rendir registra monto usado, tipo de comprobante (boleta/factura), folio, proveedor y detalle. Esta versión registra los datos del comprobante; no almacena archivos adjuntos. Si no se usó dinero, se registra `sin_gasto` con explicación y vuelve todo el retiro.
- El vuelto puede contarse por billetes y monedas. `returnDenominations` es opcional; cuando se envía, el servidor exige que el desglose sume exactamente retiro menos monto usado antes de registrar la rendición. Se conserva en el retiro y en el snapshot del libro de caja. No modifica el gasto del comprobante.
- El vuelto se calcula en el servidor: retiro - usado. El monto usado no puede superar el retiro; para ampliar el anticipo se registra otro retiro.
- Una rendición devuelve el excedente una sola vez. No se edita ni borra el movimiento original. Los pendientes permanecen visibles; los rendidos muestran los últimos 30 días. Los registros anteriores permanecen en la base y en los cierres guardados.
- Un retiro puede quedar pendiente al cerrar. Al rendirlo otro día, el vuelto entra en la sesión abierta que lo recibe; el cierre anterior conserva su snapshot.

Rutas del personal (cookies y permisos habituales):

| Ruta | Acción |
| --- | --- |
| `GET /api/register-cash` | Saldo, movimientos y retiros permitidos para ese usuario |
| `POST /api/register-cash/withdrawals` | Emitir retiro: `sessionId`, `amount`, `recipient`, `purpose` |
| `POST /api/register-cash/withdrawals/{id}/settle` | Rendir: `sessionId`, `spentAmount`, `documentType`, `documentNumber`, `supplier`, `detail` |

Las escrituras requieren `Idempotency-Key` UUID. Repetir la misma clave/cuerpo recupera el resultado actual, incluso tras reiniciar o cerrar la sesión original. Otro cuerpo devuelve `IDEMPOTENCY_CONFLICT`. La interfaz conserva el intento en sessionStorage por usuario; ante una respuesta incierta ofrece recuperación con la misma clave. No reintenta cobros ni movimientos automáticamente.

El cierre muestra los retiros y vueltos calculados desde el libro de caja; ya no permite declararlos manualmente. Ignora montos manipulados en esos campos de la solicitud. El PDF comprimido añade destinatario, comprobante, usado y vuelto. Las versiones anteriores del PDF y los ajustes manuales históricos se conservan.

## Total de tarjeta y conteo

Los cierres nuevos usan `cardTotalSource=pos`: `countedCard` se obtiene exclusivamente de ventas de tarjeta confirmadas menos devoluciones procesadas dentro del alcance de ese cierre, sin descontar comisiones. Se ignora cualquier `countedCard` enviado por el cliente. No es una consulta del lote completo del terminal ni una verificación bancaria independiente. `cardDifference=null` expresa que no se declaró un segundo total; la interfaz y el PDF omiten esa comparación.

Los snapshots históricos con declaraciones manuales conservan sus valores, diferencias y PDF. Una nueva corrección guarda otra versión con el total automático y mantiene las anteriores.

El cierre y la rendición comparten el selector de denominaciones CLP. Cero se presenta como guía con el campo vacío; al enfocarlo desaparece la guía, y `01`/`003` se normalizan a `1`/`3`. Sólo se admiten conteos enteros de hasta un millón por denominación. El servidor valida las denominaciones y sus sumas; el control visual no sustituye esa validación.

## Acceso del cajero a Inventario

El cajero puede abrir Caja e Inventario, consultar todos los productos —incluidos los insumos no vendibles— y registrar entradas, salidas o conteos, individualmente o por lote. Sólo se habilitan `POST /api/items/{id}/adjust` y `POST /api/inventory/batch` además de sus rutas previas de Caja. Crear/eliminar productos, modificar precios o unidades, devoluciones, métricas, configuración e integraciones siguen reservados al administrador. Una contraseña inicial pendiente de cambio continúa bloqueando las operaciones.

Los movimientos nuevos incluyen nombre y usuario del operador autenticado en su nota; no se toma ese actor del cuerpo de la petición. El lote conserva su fingerprint y su idempotencia anteriores; una recuperación no genera otro movimiento ni cambia su autor. Los intentos pendientes del navegador se separan por usuario. Un intento global de la versión anterior sólo se migra al espacio de un administrador.

Se reutilizan los bloqueos de productos en UUID ascendente, la revisión transaccional, el rechazo de saldos negativos y la protección de conteos cuando existen reservas o cobros Point pendientes. Permitir ajustes de stock no concede permisos para liberar reservas.

## Persistencia y bloqueos

Migración aditiva al inicializar: columnas de apertura y `sale_items.inventory_quantity`; tablas `register_cash_withdrawals`, `register_cash_entries`, `register_cash_operations`. El conteo de vuelto añade únicamente `register_cash_withdrawals.return_denominations JSONB` nullable. Las líneas históricas con `inventory_quantity=NULL` se interpretan como completamente descontadas. No hay conversión de unidades ni cambio a cantidades negativas.

Orden de escritura de caja: clave idempotente → sesión abierta → retiro → asiento/operación. La sesión es el mutex compartido con ventas y cierre. Las devoluciones en efectivo de ventas de una sesión todavía abierta adquieren sesión → venta → devolución → productos ordenados → revisión, y comprueban efectivo disponible antes de completarse. Las devoluciones de sesiones ya cerradas mantienen el tratamiento histórico anterior; esta entrega no reasigna esas devoluciones a otra caja. El saldo de una sesión no puede interpretarse como saldo de una caja física compartida por varios usuarios.

Las lecturas del espacio de retiros y del cierre de sesión usan una transacción MVCC de sólo lectura. Los asientos tienen unicidad por retiro/tipo; restitución y cambio de estado se confirman juntos. Un rollback no deja el retiro marcado como rendido ni la clave idempotente consumida. Las notificaciones SSE incluyen sesiones y movimientos de caja.

## Stock

Las ventas autenticadas de Caja, tanto efectivo como Point, pueden registrar faltantes. Por línea se persiste `inventoryQuantity` (descuento real) y se expone `unstockedQuantity` (vendido sin saldo registrado). El saldo queda en cero; el faltante se muestra en carrito/historial y en la nota del movimiento. Una cancelación Point sólo restituye lo descontado realmente. Una devolución con restitución agrega las unidades físicamente devueltas por decisión explícita del administrador.

La API de integración exporta sólo saldo positivo. Un agotado responde 404 en la consulta individual; desaparece del snapshot completo y vuelve al reponerlo. Se mantienen ETag, revisión transaccional, permisos/cuotas antes de 304 y decimales. Las reservas web siguen siendo estrictas: no pueden usar la excepción de ventas sin stock del mostrador. Véanse `inventory-api.md` y `stock-reservations.md`.

## Validación

Datos y proveedores ficticios en JSON temporal y PostgreSQL aislado: apertura/arrastre/aporte, retiros concurrentes, rendición, permisos por usuario, devoluciones en efectivo, cierre concurrente, rollback, recuperación desde otro proceso, saldos decimales, cancelación Point y última unidad registrada entre POS/Point/web. También se prueba por HTTP con sesiones reales de personal ficticio. No se han escrito datos de negocio ni realizado cobros en producción. Bakery-checkout no se modifica.

`npm run validate`: build y **118 pruebas aprobadas, 0 fallidas, 0 omitidas**. La suite incluye el arreglo previo de deadlocks, reservas y garantías de lectura/autorización. Se probaron además en Chrome headless local la apertura $1.800 + $200, selección de producto sin stock, retiro $1.000 y rendición de $650 con retorno $350 contado como 3×$100 + 1×$50. La entrada real de teclado normaliza `01`/`003`; un conteo incompleto bloquea confirmar. El cajero ajustó un insumo en kg y guardó un lote, con precios y configuración bloqueados. Una respuesta HTTP 502 simulada después del commit conservó clave/cuerpo y se recuperó al recargar sin duplicar el retiro. Revisión visual de escritorio y móvil de 390 px sin desbordamiento horizontal. PDF de demostración: una página A4, aproximadamente 4 KB, texto vectorial y object streams comprimidos; el tamaño real crece con el detalle.
