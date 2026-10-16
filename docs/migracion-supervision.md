# Migración: pestaña SUPERVISION (V1.9, opcional)

**Tipo:** cambio de esquema aditivo. Es una pestaña nueva y no toca las existentes (ni `ORDENES_CODEX`).
**Quién la aplica:** el propietario, a mano en la hoja.
**Estado:** propuesta, pendiente de aplicar. Orden ORD-POS-011 (tarea POS-013).

## Por qué

Es la persistencia que usarán el motor de estados y el servicio de supervisión definidos en el
[contrato de supervisión automática](contrato-supervision-automatica.md) (§3.1 campos comunes, §4 vigencia, §5
idempotencia y reserva). Por ahora **solo se define y se lee**: el dashboard no escribe en ella y no existe motor.

El dashboard la trata como **pestaña opcional**: si no existe en la hoja, lee todo lo demás igual que hoy, sin error ni
aviso. Si existe, valida sus encabezados como las demás pestañas (columnas faltantes o duplicadas se reportan en el
diagnóstico). Por eso se puede aplicar cuando el propietario quiera, sin coordinar un despliegue.

## Aplicar

1. En la hoja, crear la pestaña `SUPERVISION`.
2. Pegar esta fila de encabezados en `A1`. Van separados por tabulador; son 24 columnas, en este orden:

```
SUPERVISION_ID	ORDEN_ID	PROYECTO_ID	TAREA_ID	REPO	ISSUE	PR	HEAD_SHA	BASE_SHA	HASH_CRITERIOS	VERSION_CONTRATO	VERSION_POLITICA	CLAVE	REVISION_ID	EJECUCION_ID	INTENTO	RONDA	ESTADO	VEREDICTO	ORIGEN	REPORTE_REF	MOTIVO	VERSION	ACTUALIZADO_EN
```

3. Inmovilizar la fila 1.
4. Opcional: en `ESTADO` y `VEREDICTO`, validación de datos con las listas de abajo.
5. Recargar el dashboard (**Actualizar datos**): en el diagnóstico, `SUPERVISION` aparece como válida con 0 filas.

**Revertir:** borrar la pestaña. El dashboard vuelve a no mostrarla y nada más la lee. Si solo se quiere vaciarla, borrar
las filas de datos y dejar la fila 1.

## Columnas

Sin texto libre del reporte: la pestaña guarda solo veredicto, referencia y motivo corto. El reporte completo vive fuera
de la hoja y se enlaza en `REPORTE_REF`. Sin secretos, correos, datos de pacientes ni datos personales.

| Columna | Regla |
| --- | --- |
| `SUPERVISION_ID` | `SUP-NNNNNN`. Estable y único por registro; no se reutiliza ni se renumera (ver IDs estables) |
| `ORDEN_ID` | `ORD-<PRY>-NNN` de `ORDENES_CODEX`. Obligatorio |
| `PROYECTO_ID` | `SIG`, `ECO` o `POS`; el de la orden |
| `TAREA_ID` | La tarea de la orden |
| `REPO` | `propietario/repositorio` del PR |
| `ISSUE` | Número del issue de la orden |
| `PR` | Número del PR supervisado |
| `HEAD_SHA` | SHA completo del head revisado (40 caracteres hexadecimales) |
| `BASE_SHA` | SHA completo de la base contra la que se revisó |
| `HASH_CRITERIOS` | Huella de los criterios de aceptación de la orden vigentes al revisar |
| `VERSION_CONTRATO` | Versión del contrato de supervisión aplicada |
| `VERSION_POLITICA` | Versión de la política de la orden aplicada |
| `CLAVE` | Clave idempotente (ver abajo). Única entre revisiones |
| `REVISION_ID` | ID de la revisión; trazabilidad (§3.1) |
| `EJECUCION_ID` | ID de la ejecución lanzada; trazabilidad (§3.1) |
| `INTENTO` | Entero ≥ 1. Intentos de lanzamiento de esa revisión |
| `RONDA` | `0` revisión inicial; `1` y `2` correcciones. Nunca mayor que 2 |
| `ESTADO` | Uno de los 8 estados de abajo |
| `VEREDICTO` | Vacío mientras no hay reporte; si no, `CONFORME`, `CAMBIOS` o `INCONCLUSO` |
| `ORIGEN` | Origen autenticado del evento (por ejemplo `coordinador` o `propietario`); nunca texto copiado de un comentario |
| `REPORTE_REF` | Referencia al reporte (ID o enlace). Nunca el texto del reporte |
| `MOTIVO` | Motivo corto del estado (una línea, sin hallazgos ni evidencias) |
| `VERSION` | Entero; sube en 1 con cada cambio de la fila (control de concurrencia, como `TAREAS`) |
| `ACTUALIZADO_EN` | Fecha/hora ISO 8601 del último cambio |

## Estados válidos

Son los 8 estados de [contrato §2](contrato-supervision-automatica.md#2-estados-de-supervisión). **No sustituyen** los
estados de la orden.

| Estado | Significa |
| --- | --- |
| `PENDIENTE` | Esperando autorización, presupuesto, comprobaciones o reserva |
| `EN_REVISION` | Reserva persistida y solicitud enviada |
| `CAMBIOS_SOLICITADOS` | Reporte `CAMBIOS` recibido |
| `CORRIGIENDO` | Solicitud de corrección enviada |
| `APROBADO_TECNICAMENTE` | Reporte `CONFORME` vigente; nunca fusiona |
| `DESACTUALIZADO` | Cambió head, base, criterios o política |
| `BLOQUEADO` | `INCONCLUSO`, lanzamiento desconocido, origen no autenticado o fallo de registro |
| `ESCALADO` | Decide el propietario |

Las transiciones, su orden y sus condiciones viven solo en el contrato; este documento no las repite.

## IDs estables y clave idempotente

- **IDs estables.** `SUPERVISION_ID`, `REVISION_ID` y `EJECUCION_ID` se asignan una vez y no se reutilizan ni se
  reescriben, aunque el registro quede obsoleto. Un reporte tardío o histórico conserva sus IDs; no cambia el estado
  (contrato §4).
- **Clave idempotente (`CLAVE`).** Se forma con `REPO + PR + HEAD_SHA + BASE_SHA + HASH_CRITERIOS + VERSION_CONTRATO +
  VERSION_POLITICA` (contrato §5), en ese orden, separados por `|`. Dos eventos con la misma clave son la misma
  revisión: el segundo no crea otra fila ni otra ejecución. Una corrección (ronda +1) cambia `HEAD_SHA` y por tanto crea
  clave nueva.
- **Una sola fuente de verdad.** La orden conserva sus estados en `ORDENES_CODEX`; aquí solo se guarda el ciclo de
  revisión. Un dato no se duplica entre ambas pestañas más allá de las referencias (`ORDEN_ID`, `TAREA_ID`).

## Lectura por el dashboard

- Pestaña ausente: sin estado, sin aviso y sin cambios en el resto de la lectura.
- Pestaña presente con encabezados correctos: se lee (`ds.supervision`); columnas extra se ignoran y el orden puede variar.
- Pestaña presente con encabezados incorrectos: se reporta en el diagnóstico como en las demás (`faltan columnas`,
  `columnas duplicadas` o `fila de encabezados vacía`) y no se muestran sus datos.
- No hay escrituras: `SUPERVISION` no está en `WRITE_HEADERS`. Cualquier escritura futura requiere otra orden.
