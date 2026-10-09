# PROJECT-OS V1.1 — Sincronización a Google Sheets

## Estado
Implementado para revisión en PR. **No activo en producción** hasta configurar una cuenta de servicio,
compartir la hoja y pasar una prueba manual; sin `schedule`.

## Acceso seguro (solo tras aprobar este PR)
1. En Google Cloud, seleccionar un proyecto bajo tu control y habilitar **Google Sheets API**.
2. Crear una **cuenta de servicio dedicada** para PROJECT-OS. Evitar reutilizar credenciales de otras aplicaciones.
3. Compartir únicamente el [Google Sheets maestro](https://docs.google.com/spreadsheets/d/16UXe7fm90fOTTVJhI_RZ8__I876u2buvjeLGr5cJ-Ic/edit)
   con el correo de la cuenta de servicio y permiso **Editor**. No compartir por enlace público.
4. Solo si tu política de seguridad permite claves JSON, crear una clave de la cuenta de servicio.
   Guardar el JSON completo en el secret de repositorio
   `PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON`. No subirlo a Git ni enviarlo al chat.
5. Mantener `PROJECT_OS_GH_READ_TOKEN` de solo lectura sobre los repositorios fuente.
6. La alternativa recomendada para producción a largo plazo es **Workload Identity Federation
   (OIDC)** en lugar de claves JSON de larga duración.

## Ejecución de prueba
- Tras revisión y merge del PR a `main`, abrir **Actions > PROJECT-OS — Manual GitHub evidence report**.
- Elegir fecha `2026-10-07` y activar `sync_to_sheets=true` (desactivado por defecto).
- Examinar el informe en el artefacto y verificar que `EVIDENCIAS` solo contiene nuevas filas,
  con `REFERENCIA_EXTERNA_ID=github:<repo>:<tipo>:<id>`.
- Verificar `SYNC_RUNS` con un identificador del job GitHub Actions, fecha y conteos.
- Ejecutar de nuevo el mismo día y comprobar que no se repiten evidencias.
- Las evidencias previamente insertadas manualmente se respetan por URL coincidente.

## Garantías y límites
- Rechaza informes con errores de recopilación antes de escribir.
- Valida cabeceras y repositorios configurados.
- Una única escritura por pestaña; si falla la escritura de SYNC_RUNS, la siguiente
  ejecución detecta evidencias previamente insertadas y no las duplica.
- El workflow utiliza **concurrency serializada** para prevenir dos escritores simultáneos
  desde ese workflow. NO asegura exclusividad contra otras herramientas que escriban al mismo tiempo.
- Hasta 5000 filas exploradas por pestaña; aborta al alcanzar el límite.
- `TAREA_ID` permanece vacío: vinculación posterior requiere conciliación humana.
- `CONFIRMADO` valida existencia del evento en GitHub, no cumplimiento de hitos o tareas.
- No modifica `PROYECTOS`, `TAREAS`, `HITOS`, `PLAN_DIARIO` ni `DECISIONES`.
- Los informes siguen disponibles como artefactos 30 días.
- No ejecuta en segundo plano hasta que se apruebe programación y monitoreo.
