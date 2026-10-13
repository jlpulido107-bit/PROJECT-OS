# Brief del proyecto POS — PROJECT-OS

Memoria del proyecto para la sesión de planeación (`/planear-proyecto`). Solo recoge datos con fuente; lo que no
la tiene se marca como hipótesis. Fuente operativa: la hoja «PROJECT-OS V1 — Tablero maestro».

## Objetivo

Sistema de dirección y seguimiento de los proyectos del propietario (fuente: pestaña PROYECTOS). Permite:
- evaluar el estado de los proyectos;
- estar en sintonía con GitHub, las tareas pendientes y las metas;
- delegar a Codex el trabajo técnico acotado.

## Métricas

- Horas reales contra asignadas por semana (ASIGNACIONES y TIEMPOS; vista `/estado`).
- Metas en plazo frente a metas en riesgo o vencidas (HITOS; vista `/estado`).
- Órdenes a Codex: enviadas, revisadas y fusionadas sin retrabajo (ORDENES_CODEX, desde que exista la pestaña).

## Decisiones vigentes

| Fecha | Decisión | Fuente |
| --- | --- | --- |
| 2026-10-12 | V1.6 declarada «estable con excepciones aceptadas» | [Acta de cierre](operacion-v1-6/acta-cierre-v1-6.md) |
| 2026-10-13 | Prioridad de V1.7: primero planeación (plan contra real, capacidad), luego enlace con git y después actualizaciones manuales | Conversación con el propietario |
| 2026-10-13 | Una sesión de Claude Code por repositorio. Órdenes a Codex aprobadas en la hoja. Roles: mano derecha, ingeniero, analista, mercadólogo y financiero | [Modelo de trabajo](mano-derecha.md) |
| 2026-10-13 | Página `/estado` desplegada (revisión `00002-58z`) | [Registro](estado-produccion-v1-7-2026-10-13.md) |

## Hipótesis abiertas

- Delegar en Codex tareas de riesgo bajo ahorra horas del propietario sin bajar la calidad. Se prueba con POS-009.
- Registrar los tiempos en TIEMPOS es sostenible a diario. Si no lo es, plan contra real no tendrá datos y habrá que
  simplificar el registro.

## Riesgos

- La hoja queda desactualizada respecto a GitHub. La revisión semanal lo detecta (POS-010).
- La verificación E1 de V1.6 está pendiente para el 2026-11-11 (issue jlpulido107-bit/PROJECT-OS#22).

## Glosario

- **Meta:** fila de HITOS.
- **Orden:** fila de ORDENES_CODEX, un encargo a Codex aprobado por el propietario.
- **Parte de estado:** resumen por roles que da `/planear-proyecto`.
