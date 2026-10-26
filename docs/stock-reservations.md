# Reservas de stock para el checkout

Las reservas usan el saldo neto disponible que ya consume Caja. Reservar descuenta una vez; confirmar no vuelve a descontar; liberar o vencer repone una vez. El pedido comercial, los compradores y los cobros online permanecen en el repositorio `bakery-checkout`. Las reservas confirmadas generan movimientos de inventario, sin incluir cobros web en cierres de efectivo o Point.

Las ventas autenticadas del mostrador pueden superar el saldo registrado: se conserva el saldo mínimo en cero y se registra `inventoryQuantity` (descuento real) y `unstockedQuantity` (faltante) por línea. Esta excepción no se aplica a reservas web, que siguen exigiendo saldo completo. Una cancelación Point restituye sólo `inventoryQuantity`; no inventa stock por la parte sin registro ni readquiere unidades de reservas online. Por tanto, puede haber varias ventas POS con faltante, pero la suma de asignaciones de stock registrado entre canales sigue siendo exclusiva. Una devolución con restitución es una decisión explícita sobre productos físicamente devueltos y suma la cantidad efectivamente retornada.

## Activación y permisos

Se requiere PostgreSQL para todas las reservas, incluso en desarrollo. El arranque rechaza activar escrituras con almacenamiento JSON o con la API desactivada.

```dotenv
INVENTORY_API_ENABLED=true
INVENTORY_API_ENVIRONMENT=production
INVENTORY_RESERVATIONS_ENABLED=true
INVENTORY_RESERVATION_TTL_SECONDS=900
```

El plazo configurable admite 60–1800 segundos; por defecto es 900 (15 minutos). Sólo afecta reservas nuevas y no cambia los vencimientos de Point. La función permanece desactivada por defecto para un despliegue controlado.

Para pausar nuevas compras, usar `INVENTORY_RESERVATIONS_ENABLED=false`: bloquea crear reservas e iniciar pagos, pero conserva consulta, confirmación y liberación de las existentes mientras la API siga habilitada. El worker continúa restituyendo los apartados abandonados. No apagar toda la API para una pausa operativa, porque eso también bloquea a los consumidores que deben reconciliar pagos.

En **Configuración → API de stock**, un administrador habilita **Permitir reservas** para una integración concreta. Añade el permiso `inventory:reserve` a `inventory:read`; sus claves actuales adquieren ese permiso sin publicar ni copiar el secreto otra vez. Las integraciones existentes siguen siendo de lectura hasta que se habiliten expresamente. No se puede quitar el permiso o borrar la integración mientras tenga unidades pendientes de resolución. Sí se puede revocar una clave comprometida y emitir otra de la misma integración.

La API continúa siendo privada entre servidores y sin CORS abierto. Las cookies del personal no autorizan rutas externas; las claves técnicas no autorizan rutas del personal. Todas las respuestas tienen `Cache-Control: private, no-store` y un `X-Request-ID`, con límites compartidos con las consultas de inventario.

## Flujo obligatorio antes de cobrar

1. El backend del checkout consulta precios, unidades y stock, presenta el total al comprador y guarda un intento de pedido estable en su propia base de datos.
2. Crea la reserva, enviando una referencia externa única y un `Idempotency-Key` UUID persistido. Sólo reserva al iniciar el checkout, no al agregar productos al carrito. El POS valida el saldo y recalcula precios y total con redondeo CLP por línea; los valores enviados son expectativas, no autoridad.
3. **Antes de llamar al proveedor de pago**, solicita `payment-pending` con un UUID `paymentAttemptId` persistido. Sólo puede hacerlo antes del vencimiento y con la reserva aún vigente. Si falla o la respuesta es incierta, recupera la reserva y verifica ese mismo intento antes de iniciar un cobro.
4. Una reserva en `payment_pending` no vence automáticamente. El checkout debe consultar el estado autorizado del proveedor y reconciliarlo de forma durable aunque el navegador se cierre o el servidor se reinicie.
5. Tras aprobación verificada en el servidor, llama a `confirm` con el intento, referencia del pago e importe CLP. Sólo entonces confirma la preparación/entrega. Un retorno del navegador o una afirmación del comprador no acreditan el pago.
6. Tras rechazo/cancelación autorizados, llama a `release`. Si hubo un timeout creando el pago, primero comprueba con la referencia idempotente que no existe un pago que pueda aprobarse. Un resultado desconocido mantiene las unidades retenidas y exige reintentos/alerta del checkout.

El POS confía en la integración autorizada para verificar el proveedor; no recibe claves de Mercado Pago ni datos de tarjeta. Implementar este servicio no activa por sí mismo los cobros del checkout, su publicación de productos, su conciliador ni su proveedor de pago.

## Rutas externas

Todas requieren `Authorization: Bearer …` con `inventory:reserve`. Todas las escrituras requieren un `Idempotency-Key` UUID. No se admiten parámetros de consulta ni campos de comprador.

| Ruta | Uso |
| --- | --- |
| `POST /api/integrations/v1/reservations` | Reservar todo el carrito de forma atómica |
| `GET /api/integrations/v1/reservations/{id}` | Recuperar el estado, sólo para la integración propietaria |
| `POST /api/integrations/v1/reservations/{id}/payment-pending` | Retener las unidades antes de iniciar el pago |
| `POST /api/integrations/v1/reservations/{id}/confirm` | Confirmar sin otro descuento de stock |
| `POST /api/integrations/v1/reservations/{id}/release` | Devolver las unidades pendientes una sola vez |

Crear una reserva:

```json
{
  "externalReference": "order-UUID:attempt-UUID",
  "currency": "CLP",
  "expectedTotal": 2400,
  "items": [{
    "itemId": "8f39e7d9-73fd-43aa-8dd1-24a97a3fdc88",
    "quantity": "2.00",
    "unit": "pieces",
    "unitPrice": 1200
  }]
}
```

Las cantidades son strings con exactamente dos decimales, entre `0.01` y `10000.00`, con hasta 100 productos distintos. El cliente confirma la unidad del POS; no se convierten piezas a kilos. Deben existir precio positivo, `sellable=true` y fecha no vencida cuando se informa fecha. La selección/publicación online y los alérgenos pertenecen al checkout y siguen requiriendo revisión humana. No se activa un margen de seguridad por deducción.

El inicio de pago recibe `{ "paymentAttemptId": "UUID" }`. La confirmación recibe:

```json
{
  "paymentAttemptId": "UUID",
  "paymentReference": "provider:merchant:payment-id",
  "amount": 2400,
  "currency": "CLP"
}
```

La referencia de pago debe identificar al proveedor/cuenta y pago. Es única dentro de la integración. El importe debe coincidir con la reserva, cuyo precio queda congelado al reservar. Una modificación posterior de precio no cambia un cobro ya acordado.

Para liberar antes de iniciar un pago: `{ "reason": "checkout_cancelled" }`. Después de iniciar el pago, son obligatorios el intento original, la declaración de reconciliación y un motivo autorizado:

```json
{
  "reason": "payment_rejected",
  "paymentAttemptId": "UUID",
  "outcomeVerified": true
}
```

Otros motivos permitidos: `payment_cancelled` y `payment_not_created`. Este último exige haber comprobado que el intento no generó ni puede generar un pago. No usar `checkout_cancelled` ni un temporizador local para liberar un pago en curso.

La respuesta contiene `id`, `externalReference`, `status`, `total`, líneas con precio/cantidad, `inventoryApplied`, vencimiento y fechas de transición. Las escrituras añaden `replayed` y `Idempotency-Replayed`. Crear devuelve `201` la primera vez y `200` al recuperar una operación; las transiciones devuelven `200`.

## Estados e idempotencia

| Estado | Stock | Transición permitida |
| --- | --- | --- |
| `held` | Ya descontado | `payment_pending`, `released` o `expired` |
| `payment_pending` | Retenido, aunque pase el plazo inicial | `confirmed` o `released` tras reconciliar |
| `confirmed` | Consumido; no se descuenta otra vez | Terminal; un reembolso no repone alimentos automáticamente |
| `released` / `expired` | Restituido | Terminal |

El worker persistente revisa vencimientos cada 10 segundos y al arrancar. Sólo vence `held`; varias réplicas pueden ejecutarlo con bloqueos y `SKIP LOCKED`. Tras el plazo puede haber un breve saldo conservador hasta que termine la restitución; nunca vuelve a ofrecerse una unidad sin confirmar esa transacción. Si el worker falla, el stock permanece retenido y se registra una alerta de error en logs. Los pagos pendientes no se liberan por caída o reinicio del worker.

Una clave repetida con el mismo cuerpo normalizado recupera la misma reserva y su **estado actual**, sin alargar el plazo. La misma clave con otra operación o cuerpo devuelve `409 IDEMPOTENCY_CONFLICT`. Una referencia externa con otra clave devuelve `409 EXTERNAL_REFERENCE_EXISTS`: usar la clave original para recuperar un timeout. Al iniciar otro intento después de terminar uno, usar nueva referencia externa e idempotencia. Las claves se registran al confirmar una operación válida; los errores de validación no generan descuentos ni registros de idempotencia.

Repetir la confirmación del mismo intento y referencia no duplica el consumo. Reutilizar un pago en otra reserva devuelve `409 PAYMENT_ALREADY_USED`. Confirmar después de liberar o vencer se rechaza; el checkout debe registrar `paid_requires_review`, impedir la entrega y gestionar compensación/reembolso. Esta entrega no readquiere stock automáticamente después de una liberación. Un pago aprobado tarde sigue siendo confirmable si permanecía correctamente retenido en `payment_pending`.

## Operación, auditoría y concurrencia

El administrador puede revisar pendientes e historial en Configuración y liberar una reserva manualmente. Para un pago en curso, la interfaz exige verificar primero su cancelación/rechazo. El cajero no administra reservas ni cambia claves: ve el saldo disponible ya descontado en Caja.

No se permite contar saldo absoluto, cambiar unidad o borrar un producto con reservas online activas. Recepciones de stock y ventas del saldo restante siguen disponibles. Los triggers PostgreSQL también protegen la eliminación/cambio de unidad y el límite de capacidad. Una importación que intenta reemplazar productos reservados falla de forma atómica.

Las tablas `stock_reservations`, `stock_reservation_lines` y `stock_reservation_operations` conservan estado, cotización y referencias de reintentos, sin compradores ni secretos. `movements.reservation_id` vincula reservas y restituciones. El stock, movimiento, reserva y operación idempotente se confirman juntos. Borrar credenciales de una integración terminada no borra su historial de reservas.

Reservas, Caja y Point bloquean los mismos productos en orden estable. Un carrito con una línea insuficiente revierte todas. No se mantiene una transacción de inventario abierta mientras se llama al proveedor de pagos. No se requiere Redis ni otro servicio de infraestructura para esta entrega.

Errores relevantes: `QUOTE_CHANGED`, `INSUFFICIENT_STOCK`, `PRODUCT_UNAVAILABLE`, `RESERVATION_EXPIRED`, `PAYMENT_UNRESOLVED`, `PAYMENT_MISMATCH`, `RESERVATION_NOT_PAYABLE`, `ALREADY_CONFIRMED`, `ACTIVE_RESERVATIONS`. Todos mantienen el sobre de error privado con `requestId`; el checkout no debe convertir un error en stock cero ni continuar cobrando.
