# PROJECT-OS V1 — Arquitectura

## Objetivo
Gestionar iniciativas técnicas y no técnicas sin equiparar actividad de código con avance.

## Sistemas de registro
- **Google Sheets:** fuente operativa de proyectos, hitos, tareas, capacidad semanal, planes, tiempos y decisiones.
- **Repositorios fuente:** evidencia técnica en GitHub.
- **Este repositorio:** configuración, colector, pruebas, documentación e informes regenerables.
- **Dashboard web futuro:** interfaz autenticada que consume el mismo registro, sin crear datos duplicados.

## Entidades en Sheets
`PROYECTOS`, `HITOS`, `TAREAS`, `CAPACIDAD_SEMANAL`, `ASIGNACIONES`,
`PLAN_DIARIO`, `PLAN_ITEMS`, `TIEMPOS`, `REGISTROS`, `EVIDENCIAS`,
`DEPENDENCIAS`, `DECISIONES`, `SYNC_RUNS`, `AUDITORIA`.

## Reglas clave
1. IDs únicos e inmutables y claves foráneas por ID.
2. Una tarea solo es COMPLETADO si satisface su criterio de aceptación y es validada.
3. Los commits y PRs son **evidencia**, no un cierre automático.
4. Los planes se elaboran a partir de presupuesto semanal flexible y bloqueos.
5. Las recomendaciones de IA no son aprobaciones.
6. Una sincronización se repite sin duplicar y deja evidencia de fallos.
7. El colector utiliza fecha local `America/Merida`.
8. Los datos sensibles nunca se copian a GitHub.

## Riesgos pendientes de la V1
- El pipeline aún no sincroniza Sheets automáticamente.
- El dashboard web todavía no existe.
- GitHub API puede superar cinco páginas; se informa cobertura limitada.
- Sin token no hay informe; el workflow permanece solo manual.
- Falta verificar de forma integral la operación del colector con token real y GitHub Actions.

## Seguridad de despliegue
El token de repositorios fuente debe tener acceso de **solo lectura** y seleccionarse explícitamente. El token del workflow propio solo debe operar en PROJECT-OS. No ejecutar automáticamente antes de validar.
