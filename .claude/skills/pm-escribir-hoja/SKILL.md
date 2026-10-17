---
name: pm-escribir-hoja
description: Añade una fila nueva en TAREAS, DECISIONES u ORDENES_CODEX de la hoja de PROJECT-OS con el conector de Google Sheets, con auditoría, tras el «sí» explícito del propietario (DEC-POS-006). Solo la sesión PM, solo cuando el propietario la pide.
disable-model-invocation: true
---

# PM escribe en la hoja (interina, DEC-POS-006)

Vigente hasta desplegar la orden O5b (API auditada para el agente); entonces esta skill se retira. Hoja:
`16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic`. Solo la sesión PM la usa; implementación y auditoría no escriben en
Sheets ni tienen el conector.

## Qué puede y qué no

- Solo **añade filas nuevas** en `TAREAS`, `DECISIONES` y `ORDENES_CODEX`, y filas en `AUDITORIA`.
- Nunca borra, limpia ni edita filas existentes, ni toca otras pestañas.
- Estado inicial fijo: tarea `PENDIENTE`; decisión `PENDIENTE`; orden `BORRADOR` con `RIESGO` `BAJO` o `MEDIO`.
- Prohibido: `APROBADA`, `REVISADA`, `CERRADA`, `CANCELADA`, `COMPLETADO`, `CANCELADO` y cualquier cierre de tarea.
- Sin secretos, correos ni datos personales, clínicos o de pacientes.

## Pasos

1. **Un solo escritor.** Recuerda al propietario que solo hay un escritor y pídele confirmar que no está editando
   `TAREAS`, `DECISIONES`, `ORDENES_CODEX` ni `AUDITORIA`. Sin esa confirmación, no sigas.
2. **Leer.** Lee la pestaña destino completa y `AUDITORIA` (solo lectura). Verifica los encabezados contra
   `web/src/lib/schema.ts` (`TAB_HEADERS`) y `web/src/lib/operations/constants.ts`.
3. **ID siguiente.** Calcula el siguiente ID libre (`TAR-…`, `DEC-…`/`DEC-POS-NNN`, `ORD-POS-NNN`, siguiendo el formato
   existente). Comprueba que no existe ya y que no hay duplicados (la hoja ya tiene `ORD-POS-004` duplicado: no lo
   corrijas, solo no lo repitas). Si el ID ya existe, detente.
4. **Validar límites** (`LIMITS` en `web/src/lib/operations/constants.ts`): título 160, descripción 2000, criterio 1000,
   bloqueo 500, responsable 80, notas 1000, asunto 200, decisión 2000, justificación 2000, URL 500, textos de orden
   2000. Si algo excede, detente y pídele al propietario acortarlo.
5. **Mostrar y esperar.** Muestra al propietario la fila completa (columna por columna) y las filas de `AUDITORIA`
   que escribirás. Espera un **«sí» literal**. Cualquier otra respuesta, o silencio, es no: no escribas nada.
6. **Escribir, en este orden.**
   1. Primero `AUDITORIA`, una fila por campo con valor, en la primera fila vacía tras la última con datos:
      `AUDIT_ID` = `AUD-PM-<AAAAMMDDHHMMSS>-<NN>` (único; no choca con los `AUD-<14 dígitos>-<hex>` del dashboard),
      `FECHA_HORA`, `ACTOR` = `agente-pm`, `ENTIDAD`, `REGISTRO_ID`, `CAMPO`, `VALOR_ANTES` vacío,
      `VALOR_DESPUES`, `ORIGEN` = `agente-pm;modo=conector;op=<op>;req=<uuid>` con `op` entre `tarea.crear`,
      `decision.crear`, `orden.crear`. (El dashboard ignora estas filas por su patrón `dashboard-v1.4`: es esperado.)
   2. Luego la fila de la entidad, en la primera fila vacía tras la última con datos. En `TAREAS`: `VERSION` = `1` y
      `ACTUALIZADO_EN` con la fecha/hora actual.
7. **Releer y verificar.** Relee la pestaña: el ID existe **una sola vez**, con los valores esperados y, en `TAREAS`,
   `VERSION` 1; y las filas de `AUDITORIA` están completas. Si algo no cuadra, **detente e infórmalo**: no corrijas,
   no borres, no reintentes.
8. **Informar** al propietario el ID creado, la fila y los `AUDIT_ID`.
