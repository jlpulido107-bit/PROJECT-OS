# Columna INSTRUCCIONES de TAREAS (ORD-POS-105)

**Tipo:** cambio de esquema aditivo. Una columna nueva al final de `TAREAS`; no cambia las otras 16.
**Quién la aplica:** solo el propietario, a mano en la hoja. Ningún agente la añade. **Estado:** pendiente de aplicar.

Guarda instrucciones paso a paso de cada tarea (texto multilínea, hasta 4000 caracteres). El dashboard las pinta en la
tarjeta (desplegable «Instrucciones») y en la página de la tarea, con saltos de línea y listas, siempre como texto.

## Antes de aplicarla (inerte)

- La lectura no la exige: `TAREAS` sigue válida y ninguna tarea muestra instrucciones.
- La API de operaciones escribe las tareas igual que antes (las mismas 16 columnas).
- Un alta (`tarea.crear`) o una edición (`tarea.editar`) que trae `instrucciones` responde 422
  `instrucciones-sin-columna` y no escribe nada, ni en `TAREAS` ni en `AUDITORIA`.

## Aplicarla

1. En `TAREAS`, escribir `INSTRUCCIONES` en la primera celda libre de la fila 1, justo después de `ACTUALIZADO_EN`
   (columna Q). Exacto, en mayúsculas y sin espacios; no debe repetirse en otra columna.
2. No llenar celdas a mano: las instrucciones entran por la API (alta o edición), con `VERSION` y `AUDITORIA`.
   Una celda editada a mano no queda auditada y la conciliación no la explica.
3. Comprobar en `/tareas` que la pestaña sigue sin avisos de esquema y crear una tarea de prueba con instrucciones
   desde *Tareas → Nueva*; su fila de `AUDITORIA` lleva `CAMPO = INSTRUCCIONES`.

No requiere desplegar: el código ya desplegado con ORD-POS-105 la detecta en la siguiente lectura.

## Reglas con la columna

- Alta y edición: hasta 4000 caracteres, multilínea (como `descripcion`: sin controles, como máximo una línea vacía
  seguida; texto que empieza por `=`, `+`, `-` o `@` recibe un apóstrofo inicial). Vaciarla en una edición la borra.
- Cada cambio sube `VERSION`, queda en `AUDITORIA` por campo y es idempotente por `requestId`.
- El agente PM solo las fija en altas; editar `instrucciones` sigue fuera de su lista de campos (403).

## Revertir

Borrar la columna `INSTRUCCIONES` (la columna completa, no solo el encabezado). Las tareas vuelven a leerse y escribirse
como antes y las instrucciones guardadas se pierden; quedan en `AUDITORIA` como historial.
