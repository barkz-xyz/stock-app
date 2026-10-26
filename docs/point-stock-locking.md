# Bloqueos de stock: Point, Caja y devoluciones

Corrección sobre `dad0040aede61850a047837652023f7de985f6ef` (PR #1). Pruebas locales del 22-10-2026 con PostgreSQL 17.11, productos ficticios y Point simulado. Sin operaciones experimentales en producción ni cambios en bakery-checkout.

## Fallo y corrección

El trigger de sentencia `bakery_inventory_revision` mantiene bloqueada la fila de `inventory_read_revision` hasta el commit. Restituir A y después B sin bloquear ambos antes permite el ciclo: cancelación posee A/revisión → Caja posee B y espera revisión → cancelación espera B.

Ahora las cancelaciones, fallos y vencimientos Point bloquean **todos** los productos de la venta mediante `ORDER BY id FOR UPDATE` antes de la primera restitución. Las devoluciones con restitución y su revisión de inventario hacen lo mismo. Se conservan las cantidades decimales, las transacciones y las marcas de restitución única.

`completeRefund`, `resolveRefundInventoryReview` y `recordCreditNote` adquieren primero la venta. Esto elimina la inversión devolución → venta frente a preparación/reconciliación, que ya adquirían venta → devolución. `completeRefund` descubre el ID inmutable de la venta sin bloquear la devolución; vuelve a leer/bloquear la devolución después de la venta.

La creación de líneas de devolución también implica bloqueos FK sobre productos. Preparación y reconciliación Point bloquean todos los productos de la venta antes de insertar esas líneas. Los productos se bloquean antes de bloquear líneas de devolución: así no se invierte el orden frente al `ON DELETE SET NULL` de una eliminación de producto.

## Orden auditado

Actualización de caja del 26-10-2026: la finalización de una devolución **en efectivo** adquiere primero la sesión de caja original, antes de venta → devolución → productos. Comparte ese mutex con retiros, ventas y cierre. Las devoluciones Point conservan el orden de esta tabla. Véase [cash-register-operations.md](cash-register-operations.md).

Regla común: **todos los productos existentes afectados, en UUID ascendente, antes de modificar cualquiera de ellos o adquirir la revisión**. No se adquieren productos adicionales después de bloquear la revisión. Las llamadas a proveedores quedan fuera de las transacciones de stock.

| Camino | Orden y observaciones |
| --- | --- |
| Nueva venta Caja/Point | Idempotencia → sesión de caja, si existe → todos los productos ordenados → nueva venta/líneas → actualización de productos/revisión → movimientos. La venta es nueva y no es accesible por otras transacciones antes del commit. |
| Estado/cancelación Point | Venta existente → todos sus productos ordenados si hay restitución o devoluciones que ingerir → restitución/revisión → devolución y líneas, si corresponde → estado. |
| Preparación de devolución | Venta existente → devoluciones existentes → todos los productos de la venta ordenados → nuevas líneas (incluidos sus FK). No modifica cantidades. |
| Finalización/revisión de devolución | Venta existente → devolución → todos los productos de la devolución ordenados si se restituye → líneas → restitución/revisión → movimientos/estado. |
| Nota de crédito | Venta existente → devolución → documento. No modifica stock. |
| Fallo de devolución | Un UPDATE de devolución en autocommit; no espera después por venta, productos ni revisión. |
| Entrada/conteo por lote | Idempotencia → todos los productos ordenados → actualización/revisión → movimientos/resultado. Ya cumplía la regla. |
| Ajuste/edición/eliminación individual | Único producto → validaciones de reservas/Point (lecturas MVCC) → modificación/revisión. El DELETE puede bloquear líneas hijas; no espera por la cabecera de venta o devolución. |
| Alta individual | Producto nuevo → revisión → movimiento; no adquiere otro producto existente. |
| Reserva web | Integración/idempotencia → reserva, si ya existe → todos los productos ordenados → cambios/revisión → movimientos. Ya cumplía la regla. |
| Liberación/vencimiento web | Reserva → todos sus productos ordenados → restitución/revisión. El worker usa `SKIP LOCKED` y no adquiere después la integración. |
| Importación/seed manual | Bloqueos exclusivos de tablas antes de reemplazar productos; fuera del tráfico habitual. Auditados, no ejecutados. |

La venta existente es el ancla de serialización para sus devoluciones, documentos y reconciliaciones. Aunque reconciliación y finalización visitan esas filas hijas en momentos distintos, ningún camino que espera por la venta mantiene primero una devolución bloqueada. Las ventas independientes sólo comparten productos/revisión y respetan su orden común.

Los triggers protectores de reservas leen sus saldos con MVCC; no añaden una espera inversa por reservas. Las decisiones de asignación siguen consultando PostgreSQL bajo los bloqueos originales. No se añadieron reintentos automáticos de cobros ni readquisición de stock.

## Prueba determinista y resultados

`server/point-stock-deadlock.test.js` crea un esquema aislado y usa el trigger real activo. Un trigger adicional de prueba `zz_test_restock_gate`, AFTER STATEMENT con tablas de transición, pausa la primera restitución **después** del trigger de revisión mediante un advisory lock. `pg_blocking_pids()` confirma que Caja ya espera por la cancelación antes de abrir la barrera; `FOR UPDATE NOWAIT` acredita que la revisión está bloqueada. No se desactiva ningún trigger ni se coordina mediante sleeps.

| Caso | Antes | Después |
| --- | --- | --- |
| A/B inicialmente 3; Point reserva 1 de cada uno; cancelación contra Caja B=1 | HTTP 500, `40P01` en Caja | Ambas respuestas 200; A=3, B=2 |
| Repetir cancelación/reconciliación | — | Sin nueva restitución, movimientos ni revisión de productos |
| Orden de entrada inverso, lote superpuesto, dos cancelaciones superpuestas | — | Ambas operaciones finalizan; saldos y movimientos exactos |
| Devolución y revisión Point, nombres en orden opuesto al UUID | — | Sin ciclo; reejecución no duplica stock |
| Finalización/revisión/nota contra un reconciliador que posee la venta | — | Venta siempre antes de devolución |
| Error en la segunda restitución | — | Rollback de cantidades, revisión, movimientos y estado |
| Reinicio después del rollback y repetición tras perder la respuesta | — | Una sola restitución persistida |

La prueba falla sobre la base sin corregir y pasa con la corrección. Los tiempos locales no se usan como medida de rendimiento ni como criterio de coordinación.

Validación local final: `npm run validate` completó comprobación de sintaxis, build y **86 pruebas aprobadas, 0 fallidas, 0 omitidas**. La prueba nueva aporta 7 escenarios más su contenedor; su ejecución independiente también terminó con 8/8 y cero omisiones. Diff y secretos revisados; no se requieren migraciones ni nuevas variables.

La suite completa conserva las pruebas de última unidad Caja/Point/web, idempotencia, cancelación/vencimiento, recuperación tras reinicio, pagos inciertos retenidos, revisión/ETag con commit/rollback, cachés independientes, revocación/permisos/cuotas antes de 304, contrato HTTP 1.1 y actualización/sesiones/eventos de interfaz del PR #1.

```powershell
$env:TEST_DATABASE_URL='postgresql://bakery_test@127.0.0.1:58439/postgres'
$env:PGSSLMODE='disable'
node --test --test-reporter=tap server/point-stock-deadlock.test.js
npm run validate
```

No hay migración de esquema ni cambios en triggers, snapshots, contrato HTTP o interfaz. Se añade una lectura bloqueante previa en los caminos de restitución y devolución: puede esperar por operaciones que usan los mismos productos; ésa es la serialización necesaria. La revisión sigue publicándose atómicamente con los productos y sin usar NOTIFY como prueba de vigencia. Se mantiene el límite conocido de contención de esa fila compartida entre escritores; esta corrección elimina el ciclo, no esa serialización.
