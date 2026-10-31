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

## Pruebas

Para desarrollo se puede usar `MERCADOPAGO_MOCK=true`. En produccion, hacer
primero una consulta de terminales, confirmar la asociacion y ejecutar una
venta pequena antes de cambiar mas configuracion.
