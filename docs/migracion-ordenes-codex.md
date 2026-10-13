# Migración: pestaña ORDENES_CODEX (V1.7)

**Tipo:** cambio de esquema aditivo. Es una pestaña nueva y no toca las 12 existentes.
**Quién la aplica:** el propietario, a mano en la hoja.
**Estado:** propuesta, pendiente de aplicar.

## Por qué

Hace falta que las órdenes para Codex se aprueben en la fuente operativa y queden trazables, sin dar a Claude permiso de
escritura en la hoja. Modelo de trabajo: [mano derecha](mano-derecha.md).

## Aplicar

1. En la hoja, crear la pestaña `ORDENES_CODEX`.
2. Pegar esta fila de encabezados en `A1`. Van separados por tabulador; son 15 columnas, en este orden:

```
ORDEN_ID	PROYECTO_ID	TAREA_ID	TITULO	OBJETIVO	CONTEXTO	CRITERIOS_ACEPTACION	FUERA_DE_ALCANCE	COMO_PROBAR	RIESGO	ESTADO	ISSUE_URL	PR_URL	NOTAS	ACTUALIZADO_EN
```

3. Inmovilizar la fila 1.
4. Opcional: en `RIESGO` y `ESTADO`, poner validación de datos con las listas de abajo.

**Revertir:** borrar la pestaña. Nada más la lee: el dashboard y el colector no cambian con esta migración.

## Columnas

| Columna | Regla |
| --- | --- |
| `ORDEN_ID` | `ORD-<PRY>-NNN`, por ejemplo `ORD-POS-001`. Es estable y no se reutiliza nunca, ni siquiera si la orden se cancela |
| `PROYECTO_ID` | Un ID de PROYECTOS con repositorio: `SIG`, `ECO` o `POS` |
| `TAREA_ID` | La tarea de TAREAS que avanza esta orden. Obligatoria |
| `TITULO` … `COMO_PROBAR` | Texto de la orden. Sin secretos, correos, datos de pacientes ni datos personales |
| `RIESGO` | `BAJO`, `MEDIO` o `ALTO`. `ALTO` no se delega |
| `ESTADO` | Ver la tabla de estados |
| `ISSUE_URL`, `PR_URL` | Las pega el propietario con lo que informe `/orden-codex` |
| `ACTUALIZADO_EN` | Fecha `AAAA-MM-DD` del último cambio |

## Estados

| De | A | Quién | Condición |
| --- | --- | --- | --- |
| — | `BORRADOR` | Propietario (pega la fila que redactó Claude) | Campos completos |
| `BORRADOR` | `APROBADA` | **Solo el propietario** | Revisó alcance y riesgo |
| `APROBADA` | `ENVIADA` | Propietario, con el `ISSUE_URL` que informa `/orden-codex` | El issue existe |
| `ENVIADA` | `PR_ABIERTO` | Propietario, con el `PR_URL` | Codex abrió el PR |
| `PR_ABIERTO` | `REVISADA` | Propietario, tras la evaluación de Claude en el PR | Hay evaluación contra los criterios |
| `REVISADA` | `CERRADA` | Propietario | PR fusionado o cerrado con decisión |
| Cualquiera | `CANCELADA` | Propietario | Con motivo en `NOTAS` |

**Desde el dashboard (V1.8 F3)**, con la escritura activa ([escritura-v1-8.md](escritura-v1-8.md)), el propietario
también puede:
- crear órdenes en `BORRADOR`;
- **aprobar** (`BORRADOR` → `APROBADA`), solo si la orden está completa, su tarea existe en el mismo proyecto y el riesgo
  no es `ALTO`;
- **cancelar** cualquier orden no terminada, con un motivo que se guarda en `NOTAS`.

Cada cambio queda en `AUDITORIA`. Como la pestaña no tiene `VERSION`, el dashboard envía el `ESTADO` que vio el
propietario: si cambió entretanto, se rechaza y hay que recargar.

**Reglas:**
- Claude nunca cambia un estado: solo propone el cambio.
- Una orden `CERRADA` no cierra su tarea. La tarea la cierra el propietario en TAREAS.

## Idempotencia y concurrencia

- **Idempotencia.** El título del issue empieza por `[ORDEN_ID]`. Antes de crear un issue, `/orden-codex` busca ese ID
  en los issues del repositorio, abiertos y cerrados. Si ya existe, no crea otro y devuelve el enlace. Repetir la rutina
  nunca duplica.
- **Concurrencia.** Cada sesión solo procesa las órdenes de su `PROYECTO_ID`, y cada proyecto tiene un solo repositorio.
  Dos sesiones no compiten por la misma orden.
- **Auditoría.** El historial de versiones de la hoja registra quién cambió cada estado. Además, el issue y el PR quedan
  enlazados entre sí por el `ORDEN_ID` y el `TAREA_ID`.
