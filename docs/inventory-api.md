# API de inventario

Primera entrega de la integración entre Bakery POS y una futura tienda en otro repositorio. Implementada en código, con activación por servidor. Contrato externo: [stock-api.openapi.json](stock-api.openapi.json).

## Alcance

| Ruta | Resultado |
| --- | --- |
| `GET /api/integrations/v1/inventory` | Todo el catálogo vigente, también agotados y productos no vendibles |
| `GET /api/integrations/v1/inventory/{itemId}` | Un producto por UUID |

La respuesta proviene de una única lectura coherente, ordenada por UUID y con `count` igual a `items.length`. No admite filtros ni paginación. El saldo operativo ya descuenta ventas y reservas Point aplicadas; no es un conteo físico. La consulta no modifica existencias, movimientos, ventas o cierres.

Bakery POS conserva la autoridad del inventario. La tienda separada gestionará carrito, compradores, pedidos y pagos online. Esta entrega no reserva stock ni garantiza disponibilidad al cobrar; las reservas y confirmaciones son una fase posterior necesaria para vender existencias compartidas.

## Activación

La API está desactivada por defecto. En el servidor que deba atender integraciones, configurar:

```dotenv
INVENTORY_API_ENABLED=true
INVENTORY_API_ENVIRONMENT=production
```

Usar `INVENTORY_API_ENVIRONMENT=test` en local y staging. Sin un valor explícito, se utiliza producción bajo NODE_ENV=production o Railway, y pruebas en los demás casos. Una clave de pruebas nunca autoriza producción, ni a la inversa. Una copia de una base de producción a staging debe ejecutarse con entorno `test` para impedir usar allí claves de producción.

La API habilitada en producción requiere PostgreSQL; el arranque falla si sólo hay almacenamiento JSON. En local, las credenciales y los límites se guardan en un archivo adyacente `inventory.json.integrations.json`, separado del inventario. Contiene hashes de claves, no sus valores completos. No compartir ni versionar ese archivo. El modo JSON admite un único proceso de desarrollo.

En PostgreSQL se crean tablas aditivas `integration_clients`, `integration_keys` e `integration_rate_limits`. Se reutiliza el pool del POS. Los contadores son atómicos y compartidos entre réplicas; no se requiere Redis. Exportar no escribe en tablas de negocio.

## Gestión de claves

Entrar como administrador en **Configuración → API de stock**, también disponible en `/configuracion?tab=inventory-api`.

1. Crear una integración con nombre y vigencia de 7, 30, 90 o 365 días.
2. Copiar la clave que se muestra una sola vez y guardarla en el backend consumidor.
3. Usar **Renovar clave** para emitir una nueva con 90 días de vigencia. La anterior conserva como máximo 24 horas para actualizar al consumidor. Si no quedan claves vigentes, el botón dice **Generar clave**.
4. Revocar una clave cuando deje de usarse. La siguiente solicitud, incluso condicional, ya no estará autorizada.
5. Usar la papelera de una clave para borrarla definitivamente, o la de la cabecera para eliminar toda la integración con sus claves. El borrado requiere confirmación en la interfaz y sólo está disponible para administradores.

La ruta administrativa admite vigencias de 1 a 365 días y usa 90 por defecto. Se permiten como máximo dos claves vigentes por integración; revocar o eliminar la anterior antes de otra renovación. Revocar conserva el registro; eliminar lo borra de la base activa. Las copias de seguridad anteriores mantienen su política de retención. El secreto completo no se puede recuperar: sólo se almacena su hash.

La ventana de la nueva clave sólo se cierra con **Ya la guardé**. **Copiar clave** confirma la copia dentro de la ventana. Si el navegador bloquea el portapapeles, se intenta la copia del texto seleccionado y queda disponible **Seleccionar texto** para copiar manualmente. La clave no se guarda en el navegador.

El único permiso emitido es `inventory:read`. El cajero no puede ver ni gestionar claves. Las cookies del personal no autorizan la API externa y los tokens externos no autorizan rutas del personal.

Estas rutas administrativas requieren sesión de administrador y no pertenecen al contrato del consumidor:

| Ruta | Uso |
| --- | --- |
| `GET /api/integration-clients` | Estado y metadatos sin secretos |
| `POST /api/integration-clients` | Crear con `{ "name": "Tienda online", "expiresInDays": 90 }` |
| `POST /api/integration-clients/{clientId}/keys` | Rotar con `{ "expiresInDays": 90 }` |
| `POST /api/integration-clients/{clientId}/keys/{keyId}/revoke` | Revocar, sin repetir efectos |
| `DELETE /api/integration-clients/{clientId}/keys/{keyId}` | Borrar una clave y retirar su acceso |
| `DELETE /api/integration-clients/{clientId}` | Borrar la integración, sus claves y contadores asociados |

## Consumir desde otro backend

Ejemplo con Node.js; la clave es una variable privada del servidor consumidor, sin prefijo VITE_ ni NEXT_PUBLIC_. `BAKERY_POS_URL` es el origen del POS, sin una ruta adicional.

```js
const response = await fetch(
  new URL('/api/integrations/v1/inventory', process.env.BAKERY_POS_URL),
  {
    headers: { Authorization: `Bearer ${process.env.BAKERY_INVENTORY_TOKEN}` },
    signal: AbortSignal.timeout(10000),
  },
)
if (!response.ok) throw new Error(`Inventory unavailable: ${response.status}`)
const snapshot = await response.json()
```

No enviar la clave en la URL ni desde el navegador del comprador. No se habilita CORS abierto. Usar HTTPS fuera de las pruebas locales, o una conexión privada entre servidores controlados.

`stockQuantity` es un string decimal de dos posiciones, como `"12.25"`. `price.amount` son pesos CLP enteros, como `1200`. `expiryDate` es fecha de calendario o null; `updatedAt` es un instante UTC. El UUID es la identidad estable; el SKU puede ser null o cambiar. `sellable` refleja el POS, sin implicar publicación online.

## Actualización y errores

Guardar explícitamente el último snapshot y su ETag en el backend consumidor. Enviar `If-None-Match` en la siguiente consulta; un `304` permite reutilizar ese snapshot. Primero se comprueban credencial, permiso y límites: una clave revocada no obtiene un `304` autorizado. La representación no contiene un timestamp volátil que invalide el ETag.

Punto inicial recomendado: consultar cada 30 segundos y aumentar la espera ante fallos. Un error no significa stock cero. Se mantienen `Cache-Control: private, no-store` y `Vary: Authorization`; la CDN no decide disponibilidad.

Límites: 60 solicitudes por minuto y 15 por ventana de 10 segundos, compartidas entre claves de una integración; además 300 por minuto por IP. Son ventanas fijas, no deslizantes. La IP se guarda como hash en los contadores. Respetar `Retry-After` en `429` y `503`.

| Estado | Significado |
| --- | --- |
| `400` | UUID o parámetros inválidos |
| `401` | Clave ausente, inválida, vencida, revocada o de otro entorno |
| `403` | Falta el permiso requerido |
| `404` | Producto o ruta inexistente |
| `405` | Método distinto de GET |
| `429` | Límite de uso alcanzado |
| `503` | API desactivada, almacenamiento no disponible o datos no exportables |

Los errores contienen `{ "error": { "code": "…", "message": "…", "requestId": "…" } }`, con el mismo identificador en `X-Request-ID`. Los logs contienen identificador, integración, plantilla de ruta, método, estado y duración. No incluyen autorización, cuerpos, consultas completas ni secretos.

## Validación y continuidad

Las pruebas cubren contrato, decimales, campos permitidos, separación de identidades, persistencia y rotación de claves, revocación antes de 304, errores y cuotas. La prueba PostgreSQL usa un esquema temporal y dos pools independientes para verificar cuotas y rotaciones concurrentes sin modificar filas de negocio. El gate conserva build y todas las pruebas, con PostgreSQL obligatorio y cero skips.

Para conectar el futuro repo, usar el OpenAPI versionado y añadir pruebas de compatibilidad en el consumidor. Los cambios de precio, SKU o unidad no deben recrear UUID de productos. Las reservas futuras deben usar la misma autoridad transaccional que Caja.
