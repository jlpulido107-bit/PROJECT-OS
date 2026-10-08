# Validación técnica — 8 de octubre de 2026

**Estado:** PR #1 en borrador, sin merge. El flujo programado no está activado.

## Integración probada
- Ejecución real de GitHub Actions: https://github.com/jlpulido107-bit/PROJECT-OS/actions/runs/37829718881
- Revisión: `feature/project-os-v1-bootstrap`
- CI: sintaxis Python, JSON de configuración y **8 pruebas unitarias** correctas.
- Smoke test: usa el token temporal de GitHub Actions con **solo lectura** del repositorio `PROJECT-OS`.
- Artefacto: `project-os-api-smoke-37829718881`, con un informe Markdown y otro JSON.
- Resultado del informe de 2026-10-08: 1 repositorio, 2 ramas, 14 commits únicos, 1 PR, 0 issues, 0 errores.

El artefacto confirmó que se pudo leer un repositorio **privado**, recorrer sus ramas, deduplicar SHA y publicar un resultado. Esto no autoriza ni verifica aún el acceso a los otros repositorios privados desde Actions.

## Hallazgo corregido
El colector original consultaba solo la rama por defecto. Eso omitía trabajo de Claude Code en ramas. El colector actualizado enumera ramas, consulta los commits por rama y deduplica por SHA.

Verificación externa, realizada con el conector GitHub de ChatGPT para el día local 2026-10-07 de SIGSAH:
- 4 ramas consultadas.
- 14 SHA únicos en el período.
- PR #6 actualizado.
- 4 issues actualizados.
**Este conteo manual no constituye una ejecución de GitHub Actions ni implica tareas completas.**

## Fallos detectados y resueltos
- La primera ejecución de integración falló: el token no tenía permisos suficientes para metadatos de issues/PRs.
- Se añadió `pull-requests: read`, `issues: read` y se mantuvo `contents: read`.
- El informe manual se entrega como artefacto: no escribe commits ni altera hojas o repositorios.
- Los estados parciales de la API se reflejan en el informe; los errores HTTP incluyen código sin respuesta completa ni secretos.

## Por verificar antes de pasar a producción
1. Configurar `PROJECT_OS_GH_READ_TOKEN` con permisos de **solo lectura** de Contents, Issues y Pull Requests, limitado a SIGSAH y PROJECT-OS.
2. Revisar PR #1 y decidir sobre merge a main; sin merge el flujo `workflow_dispatch` aún no está disponible desde la rama predeterminada.
3. Lanzar el workflow manual en main con fecha local cerrada e inspeccionar la evidencia de **SIGSAH**.
4. Diseñar la sincronización con Sheets, el control de IDs y la auditoría antes de escribir datos automáticamente.
5. Diseñar autenticación del dashboard web; no compartir Sheets ni credenciales públicamente.
6. Después de confirmar lo anterior, aprobar la agenda diaria y la política de conservación.

## Alcance no probado
- Informes diarios programados.
- Autorización cruzada a SIGSAH desde Actions.
- Escritura de evidencias/plan en Google Sheets.
- Dashboard web y tareas no técnicas.
- Robustez sobre más de 40 ramas y más de 500 eventos por endpoint; el colector avisa esos límites.

**Principio:** un commit es actividad observada, no una tarea completada.
