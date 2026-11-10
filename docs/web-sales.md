# Ventas web en Bakery POS

El checkout verifica el pago consultando Mercado Pago Orders desde su servidor. Solo después de comprobar la aprobación, la moneda y el importe envía la confirmación al POS. El POS autentica al cliente de integración y valida el intento, la cotización y los importes. La llamada a la API privada representa la aprobación que verificó el checkout.

## Contrato HTTP

Usa `POST /api/integrations/v1/reservations/{id}/confirm` después de `payment-pending`, con `Authorization: Bearer <token>`, `Content-Type: application/json` e `Idempotency-Key: <UUID persistido>`. El token requiere el permiso `inventory:reserve` en el mismo entorno que la reserva.

```json
{
  "paymentAttemptId": "f4d2d9aa-20c2-430d-9fde-39f34f74d843",
  "paymentReference": "mercadopago:orders:sandbox:ORD-test-101",
  "amount": 3000,
  "currency": "CLP",
  "paymentDetails": {
    "status": "approved",
    "orderReference": "ORD-test-101",
    "paymentId": "PAY-test-101",
    "approvedAt": "2026-11-10T14:30:00-03:00",
    "shippingAmount": 900,
    "chargedTotal": 3900
  }
}
```

- `amount` conserva el significado original. Es el subtotal de productos en CLP y debe coincidir con la reserva. El POS copia nombre, unidad, cantidad y precio de las líneas reservadas.
- `paymentReference` es la referencia estable que ya utiliza el checkout. Conserva su valor en todos los reintentos. En `paymentDetails` incluye el identificador de la orden de Mercado Pago, el identificador del pago aprobado y la fecha de aprobación con zona horaria. Usa `shippingAmount: 0` para retiro o despacho gratuito. `chargedTotal` debe ser exactamente `amount + shippingAmount`.
- La respuesta `200` conserva la estructura de la reserva. Devuelve `status: "confirmed"`, `saleId`, `replayed` y el encabezado `Idempotency-Replayed`. `total.amount` sigue siendo el subtotal reservado. `GET /api/integrations/v1/reservations/{id}` también devuelve `saleId`.
- Guarda la clave y el cuerpo de confirmación antes de enviar. Ante un timeout, repite ambos. Una confirmación equivalente con otra clave también devuelve el mismo `saleId`. Una clave reutilizada con otro cuerpo devuelve `409 IDEMPOTENCY_CONFLICT`. Un intento, pago o importe que no coincide devuelve `409 PAYMENT_MISMATCH`. Un pago asociado a otra reserva del mismo entorno devuelve `409 PAYMENT_ALREADY_USED`.
- Para compatibilidad, el cuerpo original de cuatro campos se acepta como confirmación. El POS registra el subtotal de productos y usa la fecha de confirmación hasta conocer la fecha de aprobación. Despacho y total cobrado figuran como «Sin informar». Para completar esa misma venta, envía `paymentDetails` con una **nueva** clave y conserva el intento, la referencia y el subtotal originales. El `saleId` no cambia. Una confirmación guardada antes de esta versión puede registrar su venta al repetirse.
- El checkout debe actualizar su copia del [OpenAPI](stock-api.openapi.json) para enviar `paymentDetails` y conservar `saleId` si lo necesita. El cliente anterior puede seguir confirmando con los cuatro campos originales.

## Caja y comanda

Con el Point configurado, el POS encola la **COMANDA WEB** al guardar la confirmación y la envía a la impresora del terminal. Usa la misma acción de impresión personalizada del cierre de caja. La comanda muestra la referencia del pedido, los productos y cantidades, y los importes informados. Los pedidos del entorno `test` llevan la marca **PRUEBA**.

Una falla de impresión conserva la confirmación y la venta guardada. Repetir la confirmación recupera la misma venta y evita un segundo envío automático. En **Caja → Historial → Web**, el detalle muestra el estado del envío y permite imprimir o reimprimir en el Point. Si el envío queda sin confirmación, revisa el terminal antes de pedir otra copia.

El servicio usa el Point de Caja por defecto. Para enviar comandas a otro terminal, configura `MERCADOPAGO_WEB_PRINT_ACCESS_TOKEN` y `MERCADOPAGO_WEB_PRINT_TERMINAL_ID` en el servidor.

En **Cierre de caja → Cierre diario**, el total Web incluye productos y despacho informado. Si falta el importe cobrado, se contabiliza el subtotal de productos y aparece una indicación en pantalla y en el PDF. El día corresponde a la fecha de aprobación en la zona horaria del negocio. El efectivo esperado y el total Point se calculan por separado. Las ventas Web quedan sin cajero ni sesión física. Las devoluciones Web se gestionan desde el checkout.

## POS de prueba local

Crea una base PostgreSQL local vacía llamada `bakery_web_test` y usa un usuario con permiso para crear sus tablas. En el checkout de la rama POS, ejecuta:

```sh
npm ci
npm run build
export WEB_TEST_DATABASE_URL='postgresql://usuario:clave@127.0.0.1:5432/bakery_web_test'
node scripts/start-web-test.js
```

El POS escucha en [localhost:4185](http://localhost:4185/caja/historial). El arranque crea dos productos ficticios y guarda el usuario, la contraseña y el token de integración `bpos_test_` en `tmp/web-sales-test/credentials.json` con permisos privados. En esta instancia los cobros Point están deshabilitados. Usa `localhost` en el navegador para separar la sesión de la instancia habitual en `127.0.0.1`.

Para probar la impresora física con ventas ficticias, indica el archivo privado de configuración de tu Point al levantar el POS de prueba. El lanzador usa esos datos exclusivamente para enviar comandas.

```sh
WEB_TEST_POINT_PRINT_ENV_FILE=/ruta/privada/mercadopago.env \
  node scripts/start-web-test.js
```

Para probar una compra desde bakery-checkout con Mercado Pago TEST, configura **su sandbox local** con `PAYMENTS_MODE=disabled`, las credenciales TEST de Mercado Pago y `BAKERY_INVENTORY_TOKEN` del POS de prueba. El sandbox de Orders de este checkout exige `BAKERY_POS_URL=http://127.0.0.1:4175`. Libera ese puerto si lo ocupa otro POS sintético. En el primer arranque contra una base vacía, indica el catálogo del checkout para usar sus UUID publicados con nombres, precios y saldos ficticios:

```sh
WEB_TEST_PORT=4175 WEB_TEST_CHECKOUT_CATALOG=/ruta/bakery-checkout/config/catalog.json node scripts/start-web-test.js
```

Apunta el proceso sandbox a esa instancia y completa la compra con una tarjeta de prueba. El checkout actual envía la confirmación original. Para comprobar el despacho, la fecha de aprobación y el total efectivamente cobrado desde el checkout, envía la extensión del contrato descrita arriba.

La prueba automatizada crea un esquema descartable y simula la respuesta de Point en un servidor local. Verifica el rollback, los reintentos en paralelo, la falla del terminal, la reimpresión y el cierre de caja.

```sh
TEST_DATABASE_URL="$WEB_TEST_DATABASE_URL" node --test server/web-sales.test.js
```
