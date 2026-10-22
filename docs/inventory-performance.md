# Lecturas y actualización de inventario

Medición local del 22-10-2026 frente a `7615026`. PostgreSQL 17.11, Node 24.14.1, 49 productos ficticios en kg con saldo 12.25. Ninguna prueba de carga ni escritura experimental en producción; ningún cambio en bakery-checkout.

## Resultados

| Operación | Antes | Después |
| --- | ---: | ---: |
| Renders de imágenes de Caja, refresco idéntico | 196 | 0 |
| Renders de imágenes de Caja, cambia un producto | 196 | 2 |
| Renders de Inventario / tabla, refresco idéntico | 4 / 4 | 0 / 0 |
| Filas de productos leídas por un 304 caliente de integración | 49 | 0 |
| Tamaño JSON de resultados SQL por ese 304, incluidos acceso y cuotas | 10,786 B | 512 B |
| Sentencias SQL por ese 304 | 5 | 5 |
| Cuerpo HTTP del catálogo, con cambios / 304 | 11,940 B / 0 B | 11,940 B / 0 B |
| Mediana HTTP local del 304, 7 muestras sin Vite | 4.56 ms | 4.75 ms |

Los contadores de renders usan React StrictMode en desarrollo, incluidas sus dobles invocaciones. No son tiempos de producción. Las mediciones locales no demuestran una reducción de latencia de red: con 49 productos dominan acceso/cuotas y ruido del equipo. La mejora comprobada es evitar escaneo, transferencia desde PostgreSQL, normalización, hash y renders repetidos. Los bytes SQL son el tamaño JSON de los resultados observados por el driver, no bytes del protocolo PostgreSQL. `EXPLAIN ANALYZE` verifica cero ejecuciones del subplan `items` al coincidir la revisión.

La primera respuesta sigue construyendo el snapshot. Después de modificar stock se vuelve a leer y codificar; el cuerpo HTTP permanece compatible. La lectura fría añade unos 260 B de metadatos/encapsulado en el resultado SQL (10,788 → 11,046 B). Un refresco sin cambios mantuvo el carrito en una unidad y el foco en búsqueda. En Inventario se verificó foco y scroll de 400 px.

## Flujo de solicitudes y consultas

- Carga inicial: una solicitud `/api/bootstrap`; después, una reconciliación al recibir `ready` de SSE. Se mantienen esas dos lecturas porque entre el snapshot inicial y la conexión pueden ocurrir cambios. Omitir la segunda sin un cursor común perdería esa garantía.
- Bootstrap de administrador: consulta de sesión vigente, sesiones de caja y sesión activa; en paralelo inventario, movimientos recientes, ventas recientes y resumen del día. Las ventas añaden consultas de líneas/devoluciones/documentos cuando existen. El benchmark aísla las cuatro consultas de datos con historial vacío; usa identidad y sesión ficticias, sin medir el inicio de sesión del personal.
- SSE: los eventos son señales sin datos. Se agrupan durante 75 ms. Inicial, manual, reconexión, eventos y refrescos posteriores a escrituras comparten un coordinador. Una señal durante una lectura exige una lectura posterior, agrupada con las demás señales pendientes.
- Reconexión/visibilidad: se lee al recibir `ready`; se elimina la lectura adicional inmediata al volver a la pestaña. Si SSE falla, se conserva el polling de 15 s; conectado, la reconciliación es cada 60 s. Eventos de conexiones ya cerradas se ignoran.
- Carrito/Caja: referencias iguales conservan memoización y estado local. Se reutilizan filas por UUID aunque cambie su posición. Una fila modificada cambia su tarjeta; las demás conservan su referencia. Foco, búsqueda, favoritos, carrito y scroll no se reinician. Las vistas de vencimiento reciben una clave de día para actualizarse a medianoche.
- Historial y cierre conservan una señal de reconciliación explícita cuando están visibles. Una devolución de una venta fuera de las 50 ventas recientes, o un cierre de otra caja, no dependen de que cambie la identidad del array de ventas del bootstrap.
- Integración: cuota IP → credencial vigente y permisos → cuota de integración → revisión/snapshot → ETag → 200/304. La revisión nunca evita las verificaciones de acceso. Catálogo y producto individual usan el mismo mecanismo, con un máximo de 32 entradas por proceso.

## Coherencia y coste

`inventory_read_revision` tiene una fila con un UUID, actualizado por un trigger de sentencia en `items`, dentro de la transacción original. Se invalida conservadoramente ante cualquier UPDATE, aunque el cuerpo exportado sea igual: el ETag sigue derivándose del contenido, por lo que un UPDATE vacío aún puede responder 304.

La revisión y las filas proceden de una sola sentencia MVCC. Cada solicitud valida en PostgreSQL; las notificaciones ayudan a despertar la interfaz, pero no prueban vigencia. La caída del listener, una modificación SQL externa normal, otra réplica, un rollback y el reinicio del proceso no dejan una copia acreditada indebidamente. Un resultado tardío conserva su propia revisión y representación; la siguiente lectura siempre vuelve a comprobar PostgreSQL.

La fila de revisión añade una escritura y un bloqueo por sentencia que modifica productos. Los escritores de productos distintos pueden esperar ese bloqueo hasta el commit. No hay llamadas al proveedor dentro de estas transacciones; no se cambió su orden de bloqueo de productos. La suite vuelve a competir por la última unidad entre efectivo, Point y web. Si crece mucho la concurrencia de escritura, debe medirse esa espera antes de ampliar esta arquitectura.

El bootstrap completo conserva sus lecturas de sesión, ventas, movimientos y resumen. ETag evita transferir/parsear su cuerpo idéntico; la comparación estructural también conserva referencias cuando llega un 200 con contenido equivalente. Las mutaciones invalidan validadores y las transiciones de autenticación descartan los datos retenidos. No hay caché de decisiones de stock.

## Reproducir

Usar un PostgreSQL local desechable. El comando exige `TEST_DATABASE_URL`, rechaza hosts que no sean loopback y crea/borra sólo un esquema `measure_inventory_<uuid>`. No acepta `DATABASE_URL` como conexión de medición. `--uncached` desactiva únicamente el lector de snapshots de la instancia ficticia para comparar el camino anterior.

```powershell
$env:TEST_DATABASE_URL='postgresql://bakery_test@127.0.0.1:58439/postgres'
$env:PGSSLMODE='disable'
npm run measure:inventory -- before --uncached
npm run measure:inventory -- after
npm run measure:inventory -- ui --ui
npm run validate
```

`--ui` usa Chrome headless en un perfil temporal independiente; `CHROME_EXECUTABLE` permite indicar su ejecutable. Instrumenta los componentes mediante Vite sólo para esa ejecución. Simula señales SSE y temporizadores, usa datos reales del esquema local y verifica conservación de foco, carrito y scroll. No controla pestañas del usuario. Los renders anteriores se capturaron con el mismo instrumento sobre el código sin cambios; `--uncached` sólo compara el backend, no restaura la interfaz anterior. Los resultados se escriben en `output/inventory-<etiqueta>.json`, ignorado por Git.

Las pruebas adicionales cubren respuestas iguales, cambios parciales, reordenación, invalidación tras escritura/401/login, errores recuperables, reconexiones, eventos durante lecturas, revocación antes de 304, permisos, cuotas, cachés independientes, cambios sin NOTIFY, rollback, DELETE/TRUNCATE y reconstrucción desde otro proceso. La prueba de reservas reinicia procesos con reservas vencidas y pagos inciertos, recupera respuestas perdidas y comprueba restitución única.

## Límites pendientes

- Medir latencia real desde Chile después de un futuro despliegue autorizado. Este trabajo no despliega ni cambia región, CDN o variables de Railway.
- El bootstrap completo aún hace SQL y serialización; no se cachea sin una revisión de todas sus fuentes, permisos y día comercial.
- Vigilar contención de la fila de revisión si aumenta la escritura concurrente. La invalidación requiere triggers activos: procesos que los deshabiliten quedan fuera del flujo admitido.
- La memoria de representaciones está acotada a 32 respuestas por proceso; el tamaño de cada catálogo crece con el catálogo. No cambia el contrato sin paginación.
