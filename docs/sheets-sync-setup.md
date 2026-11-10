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

## Validación en la CI de los PR (sin credenciales)
- El workflow `PROJECT-OS — PR validation` (`pr-validation.yml`) **nunca** recibe `PROJECT_OS_GOOGLE_SERVICE_ACCOUNT_JSON`
  ni lee la hoja real (revisión R3-1 del PR #24). En un PR se ejecuta el código del propio PR, y `--dry-run` es una opción
  de ese código, no una barrera de permisos.
- Valida la sincronización con una hoja **en memoria**: las pruebas unitarias (`tests/test_sync_sheets.py`: esquema,
  idempotencia, dry-run sin escrituras, fallo cerrado) y `tests/sheets_fixture_dry_run.py`, que pasa el informe del smoke
  test por `read_report()` y `synchronize(..., dry_run=True)` contra esa hoja falsa.
- El preflight `web/scripts/ops/preflight-aceptacion.mjs` da **FALLO** (P12) si un workflow automático (PR, push u otro
  evento) vuelve a usar credenciales de Google, otros secretos o la API de Google.

## Validación con la hoja real (operación humana aparte)
- Es **opcional y requiere autorización explícita del propietario** cada vez. No forma parte de la CI.
- Opción sin credenciales: abrir la hoja y comparar los encabezados de `EVIDENCIAS` y `SYNC_RUNS` con `EVIDENCE_HEADER` y
  `RUNS_HEADER` de `src/sync_sheets.py`.
- Si se quiere automatizar, hacerlo con una identidad **de solo lectura** propia (Lector de la hoja y alcance
  `spreadsheets.readonly`), nunca con la clave de escritura del colector. Es la decisión D-CI (riesgo X-8).

## Ejecución de prueba (escritura; solo con autorización)
- El workflow manual escribe en la hoja: ejecutarlo solo con autorización explícita y con su opción `sync_to_sheets`
  (desactivada por defecto). El preflight da FALLO (P15) si pierde esa opción o se dispara de forma automática.
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

## Archivar EVIDENCIAS y SYNC_RUNS (solo el propietario, a mano; ORD-POS-154, DIS-09)

El colector (`src/sync_sheets.py`) lee `EVIDENCIAS` y `SYNC_RUNS` hasta la fila 5000 (`MAX_ROWS`, contando el
encabezado) y **aborta sin escribir** si cualquiera de las dos llega a 5000 filas («Sheet exceeds configured scan limit»).
El dashboard tampoco lee una pestaña de más de 5000 filas de datos (`MAX_DATA_ROWS` en `web/src/lib/schema.ts`). Ni el
colector ni la API borran o archivan filas: el archivo es manual, del propietario, y ningún agente lo hace. El límite no
se sube. Es el mismo procedimiento que el de `AUDITORIA` ([escritura §12](escritura-v1-8.md#12-límite-de-filas-y-archivo-de-auditoria-ord-pos-143)):

1. **Pausa.** No lances el workflow de sincronización mientras archivas.
2. **Respaldo.** Archivo → Historial de versiones → Nombrar la versión actual, por ejemplo «antes de archivar
   EVIDENCIAS AAAA-MM-DD».
3. **Copiar.** Copia las filas más antiguas a `EVIDENCIAS_ARCHIVO_AAAA` o `SYNC_RUNS_ARCHIVO_AAAA` (el año de las
   filas) o a otro libro. Pega solo valores. Deja al menos las filas de los últimos 3 meses. Ni el colector ni el
   dashboard leen esas pestañas.
4. **Borrar.** Borra esas filas sin tocar el encabezado (fila 1). Borra filas completas: no dejes filas vacías en medio.
5. **Comprobar.** Corre el workflow en modo de prueba (`sync_to_sheets=false`) y revisa que el informe no aborte.

**Efectos sobre lo archivado** (el colector solo ve lo que queda en la pestaña):

- `EVIDENCIAS`: la deduplicación compara `EVIDENCIA_ID`, `REFERENCIA_EXTERNA_ID` y URL solo con las filas que quedan.
  Si se vuelve a sincronizar un evento de GitHub cuya fila se archivó, se inserta de nuevo. Por eso no se archivan
  filas recientes.
- `SYNC_RUNS`: un identificador de corrida archivado (`GH-SYNC-<run>-<fecha>`) ya no se reconoce como procesado; un
  reintento de esa misma corrida vuelve a añadir sus evidencias que tampoco estén en `EVIDENCIAS`.
- `TAREA_ID` y la conciliación humana de lo archivado se conservan en la copia, no en la pestaña viva.
