# Administracion de Mercado Pago Point

Bakery POS administra la infraestructura Point desde el servidor usando
`MERCADOPAGO_ACCESS_TOKEN`. El token nunca se envia al navegador ni se guarda
en el inventario local.

## Que se puede administrar

- Cuenta vendedora: se consulta con `GET /users/me`.
- Sucursales: crear, listar, editar y eliminar mediante la API de Stores.
- Cajas: crear, listar, editar y eliminar mediante la API de POS.
- Terminales: listar, revisar sucursal/caja asociada y cambiar el modo `PDV` o
  `STANDALONE` mediante la API de terminal setup.

La pantalla esta disponible en `Configuracion` para una cuenta de administrador
autenticada. Las cuentas de cajero no pueden administrar Point.

## Recomendaciones para produccion

1. Usa en Railway el Access Token de la cuenta que recibira el dinero. Para
   Atelier del Puerto, debe ser el token de Atelier, no el de una cuenta de
   desarrollo.
2. Crea la sucursal y la caja una sola vez. Usa un `external_id` estable, por
   ejemplo `ATELIER-01` y `CAJA-01`, para poder reconciliar la configuracion.
3. Asocia el Point correcto a esa sucursal y caja desde Mercado Pago antes de
   ponerlo en modo PDV.
4. No elimines una sucursal o caja en produccion sin confirmar antes que no
   haya terminales asociadas. La eliminacion es una operacion remota y puede
   afectar la operacion del terminal.
5. Cambiar el modo del terminal debe hacerse cuando no haya un cobro en curso.
   Verifica el estado en la pantalla antes de iniciar la siguiente venta.

## Cobros y webhooks

Los cobros siguen usando Orders API con `external_reference` propio. Los
webhooks de `Order (Mercado Pago)` se configuran en el panel de la aplicacion
y el servidor consulta la order recibida antes de conciliarla. No se agrega
`notification_url` a las orders modernas: ese campo pertenece a flujos
antiguos y no reemplaza la configuracion de Webhooks del panel.

## Efectivo enviado al Point (Chile)

Activar `MERCADOPAGO_CASH_ENABLED=true` en el servidor para enviar tambien
las ventas en efectivo a `POST /v1/orders`, con
`config.payment_method.default_type=cash` y
`config.point.print_on_terminal=seller_ticket`. Requiere terminal en modo PDV.
Sin esta opcion, el efectivo sigue registrandose directamente en la caja local.

El cajero ingresa el recibido y el vuelto en la app, y completa la confirmacion
del efectivo en el Point. Solo se envia el total vendido: el dinero permanece
en el cajon, no se registra como un abono o un cobro a tarjeta. La venta queda
pendiente hasta la confirmacion autoritativa del Point; reserva el stock y
bloquea el cierre de caja mientras esta pendiente. Cancelacion, rechazo o
expiracion restauran el stock una sola vez. Si falla la conexion, recuperar
la misma venta: no crear una nueva ni registrarla tambien en el Point manualmente.
No existe fallback automatico a efectivo directo cuando esta opcion esta activa.

`MERCADOPAGO_CASH_TAX_CONDITION` define el IVA de nuevas ordenes en efectivo:
`payment_taxable_iva` por defecto o `payment_exempt_iva` para ventas exentas.
La condicion se guarda con la venta y no cambia al reintentar. El catalogo aun
no distingue impuestos por producto: no usar este flujo para una venta mixta
de productos afectos y exentos. Cambiar la configuracion requiere reiniciar
el servidor; las ventas pendientes se recuperan con su configuracion guardada.
PostgreSQL requiere ejecutar las migraciones (version 2) antes del reinicio.

La impresion usa el documento nativo del Point. No se envia XML propio ni se
genera un folio desde la app. El servicio de Boletas del comercio y su
configuracion tributaria determinan la emision. La app no detecta la
suscripcion ni afirma que exista una boleta emitida o aceptada por el SII.
Una cuenta sin el servicio puede rechazar el efectivo; eso no confirma la venta.

Para validar con un comercio habilitado: realizar una unica venta controlada
desde la app, completar el efectivo en el Point, comprobar el documento y
folio impresos y contrastarlos con el portal de Boletas y Facturas. Verificar
ademas que haya una sola venta en caja y que su vuelto sea correcto.
Las facturas se emiten desde el portal de Mercado Pago. Las devoluciones de
efectivo siguen pagandose desde caja; una eventual correccion tributaria debe
gestionarse con el emisor y no se produce por el mero registro del reembolso.

Fuentes oficiales revisadas el 2026-11-02:
- [Orders API Point para Chile](https://www.mercadopago.cl/developers/es/reference/in-person-payments/point/orders/create-order/post)
- [Servicio de Boletas y Facturas](https://www.mercadopago.cl/mp/boletas-electronicas)

## Pruebas

Para desarrollo se puede usar `MERCADOPAGO_MOCK=true`. En produccion, hacer
primero una consulta de terminales, confirmar la asociacion y ejecutar una
venta pequena antes de cambiar mas configuracion.
