# Migración: pestaña SUPERVISION (V1.9, opcional)

**Tipo:** cambio de esquema aditivo. Es una pestaña nueva y no toca las existentes (ni `ORDENES_CODEX`).
**Quién la aplica:** el propietario, a mano en la hoja.
**Estado:** la pestaña `SUPERVISION` (24 columnas, A1:X1, sin filas) fue creada por el propietario y verificada con
encabezados correctos en el orden de `TAB_HEADERS` (16/10, solo lectura); producción aún no la lee porque el código no
está desplegado. Orden ORD-POS-011 (tarea POS-013). La sección [Persistencia durable](#persistencia-durable-análisis-y-propuesta)
(ORD-POS-016) es un análisis; sus decisiones D1 a D3 están **decididas** (DEC-POS-004, 2026-10-16, ORD-POS-018), pero
**no aplicadas ni implementadas**.

## Por qué

Es la persistencia que usarán el motor de estados y el servicio de supervisión definidos en el
[contrato de supervisión automática](contrato-supervision-automatica.md) (§3.1 campos comunes, §4 vigencia, §5
idempotencia y reserva). Por ahora **solo se define y se lee**: el dashboard no escribe en ella. Existen el motor, el
validador y el extractor (PR #60, #62, #64), pero ninguno persiste nada.

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

Sin texto libre del reporte: la pestaña guarda solo veredicto, referencia y motivo corto. `REPORTE_REF` apunta al
reporte, pero **hoy no está definido dónde vive el contenido íntegro** (ver Persistencia durable). Sin secretos,
correos, datos de pacientes ni datos personales.

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
| `ORIGEN` | Origen autenticado del evento (por ejemplo `coordinador` o `propietario`); nunca texto copiado de un comentario. Es una sola columna: no distingue sesión, autor del comentario y autor del dictamen (contrato §5) |
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

## Persistencia durable (análisis y propuesta)

Contraste de lo que el contrato y `types.ts` necesitan con lo que existe hoy: `TAB_HEADERS.SUPERVISION` (24 columnas, solo
lectura), `AUDITORIA` (`AUDIT_ID, FECHA_HORA, ACTOR, ENTIDAD, REGISTRO_ID, CAMPO, VALOR_ANTES, VALOR_DESPUES, ORIGEN`,
una fila por campo) y el escritor (`service.ts`, auditoría primero, `EntityTab` limitado a `TAREAS`, `TIEMPOS`,
`DECISIONES` y `ORDENES_CODEX`). `SUPERVISION` no es entidad escribible ni se audita. No se suponen columnas ni datos
que no existan.

| Campo | Soporte durable actual | Recuperación | Fallo seguro |
| --- | --- | --- | --- |
| `estadoAnterior` (`types.ts`) | Ninguno. `ESTADO` guarda un solo valor; `MOTIVO` es texto de una línea y no se interpreta | No recuperable tras `BLOQUEADO` | Sin dato, `RECONCILIACION` va a `ESCALADO` (`engine.ts`: exige un previo distinto de `BLOQUEADO` y `ESCALADO`). Nunca se adivina |
| `cicloTerminado` | Ninguno. Hay `ESTADO` pero no «fusionado» ni «cerrado sin fusión» | No recuperable. `ESCALADO` no distingue PR fusionado de cancelado | Sin dato se trata como ciclo vigente y se verifica el PR real (fusionado o cerrado) antes de cualquier paso. Nunca se reanuda un ciclo que no se pueda comprobar terminado |
| Reserva activa | Ninguno. No hay columna ni estado de reserva; `EN_REVISION` significa «reserva persistida y solicitud enviada», sin cubrir reserva sin lanzamiento ni vencimiento | No recuperable tras reinicio; el mutex es de memoria | Reserva dudosa = lanzamiento desconocido: `BLOQUEADO`, reconciliar con el estado real, **no reenviar** |
| `REVISION_ID`, `EJECUCION_ID`, `INTENTO`, `RONDA` | Columnas existentes en `SUPERVISION`, **no escribibles**. `ronda` también la guarda `Contexto` en memoria | Se leen si alguna vez se escriben; hoy no hay filas | Sin fila o con ID repetido, no se lanza (contrato §5). Un ID no se reasigna |
| Reporte íntegro | Ninguno. `REPORTE_REF` más hash prueba qué se vio, **no lo devuelve**. `AUDITORIA` registra campos por valor, no el reporte; tamaño máximo de celda de Sheets: ❓ sin verificar | No recuperable | Sin contenido íntegro no hay `CONFORME` ni `CAMBIOS` registrado: `BLOQUEADO` conservando lo recibido hasta reconciliar. Un reporte truncado no se acepta |
| Vínculo del comentario editable | Ninguno | No recuperable | Sin vínculo al contenido verificado (ID, fecha de edición, hash), el comentario no se usa |
| Sesión, autor del comentario, autor del dictamen | Solo `ORIGEN` (una columna) | No separables | Se trata como no autenticado: `BLOQUEADO` con riesgo de manipulación |

**Conclusión:** lo actual **no basta** para reserva, recuperación ni registro íntegro. Antes de implementar reservas y
registro hay que implementar la propuesta de abajo, ya decidida (DEC-POS-004).

### Propuesta de migración (no aplicada)

Cambio aditivo, columnas nuevas **al final** de `SUPERVISION`, sin tocar las 24 actuales (el lector tolera columnas extra):

```
ESTADO_ANTERIOR	CICLO_TERMINADO	RESERVA_ESTADO	RESERVA_EXPIRA_EN	REPORTE_HASH	COMENTARIO_ID	COMENTARIO_HASH	IMPORTADO_POR	AUTOR_COMENTARIO	AUTOR_DICTAMEN	SESION_ID
```

| Columna | Valores / regla |
| --- | --- |
| `ESTADO_ANTERIOR` | Uno de los 8 estados o vacío; solo con `BLOQUEADO` |
| `CICLO_TERMINADO` | Vacío, `FUSIONADO` o `CERRADO_SIN_FUSION` |
| `RESERVA_ESTADO`, `RESERVA_EXPIRA_EN` | `ACTIVA`, `LIBERADA` o `EXPIRADA`; fecha ISO 8601. Se escribe antes de lanzar |
| `REPORTE_HASH` | SHA-256 del contenido íntegro guardado; verifica, no sustituye |
| `COMENTARIO_ID`, `COMENTARIO_HASH` | ID y hash del comentario verificado, si el reporte viene de uno |
| `IMPORTADO_POR`, `AUTOR_COMENTARIO`, `AUTOR_DICTAMEN` | Las tres identidades de contrato §5; el último es declarado |
| `SESION_ID` | Sesión de Claude que lanzó el coordinador para esa revisión (DEC-POS-002). Solo se acepta un dictamen de esa sesión, con su `REPORTE_HASH`; no sustituye a las tres identidades |

**Decisiones del propietario (DEC-POS-004, 2026-10-16).** Están decididas, **no aplicadas ni implementadas**:

1. **D1, contenido íntegro del reporte:** pestaña nueva `SUPERVISION_REPORTES`, con el JSON en partes y hash
   (`REPORTE_ID, PARTE, TOTAL, CONTENIDO, HASH_PARTE`) para evitar el límite de celda. Sin infraestructura nueva.
2. **D2, escritura:** `SUPERVISION` se escribe con el escritor auditado que ya existe (`WRITE_HEADERS` y `EntityTab`,
   auditoría primero).
3. **D3, reserva entre instancias:** un solo escritor (`maxScale: 1`) como supuesto documentado, con una reserva que
   expira. La deduplicación multiinstancia **sigue sin estar garantizada**.

Justificación: no pide infraestructura ni permisos nuevos y reutiliza la auditoría, la idempotencia y el control de
concurrencia ya probados. Cada decisión requiere su propia orden de implementación. Aplicar la migración sigue siendo
manual del propietario.

**DEC-POS-009 sustituye a D1 a D3.** El dictamen vive solo en el PR (comentario con la marca
`<!-- project-os:dictamen-revisor -->` y un JSON que valida `validarReporte`); no se persiste en `SUPERVISION` ni en
`SUPERVISION_REPORTES`. `/ordenes` lo lee de GitHub en solo lectura (ORD-POS-035) y muestra el dictamen del head actual y
el siguiente paso; D1 a D3 quedan sin aplicar.
