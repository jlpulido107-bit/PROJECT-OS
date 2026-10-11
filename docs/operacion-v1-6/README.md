# PROJECT-OS V1.6 — Operación (Misión 013)

> **Ámbito:** línea base operativa de la V1.6 **ya desplegada**. Contiene documentación, herramientas offline y
> pruebas. **Nada aquí se ejecutó contra GCP, Google Sheets ni OAuth reales**, y nada autoriza mutaciones de
> producción. Issue: [#22](https://github.com/jlpulido107-bit/PROJECT-OS/issues/22).

## Fuente de verdad

| Qué | Dónde | Naturaleza |
| --- | --- | --- |
| Estado observado del despliegue (2026-10-11) | [`estado-produccion-v1-6-2026-10-11.md`](../estado-produccion-v1-6-2026-10-11.md) | Registro fechado del propietario |
| Código **desplegado** | `7f44216bdf85a9832e014f45c27ac643e00ceff9` | Imagen `sha256:f6e46596…5c07`, revisión `project-os-dashboard-00001-gsk` |
| Base de esta misión | `main` en `509458b0025b8d0a178859b24fa4c69d2e8f678e` | Solo documentación posterior al código desplegado |
| Checklist de aceptación | [`despliegue-v1-6-aceptacion.md`](../despliegue-v1-6-aceptacion.md) | Lista de controles A–H |
| Runbook de despliegue y Puerta C | [`despliegue-privado-v1-3.md`](../despliegue-privado-v1-3.md), [`puerta-c-v1-6.md`](../puerta-c-v1-6.md) | **Histórico**: preparación, no estado presente |

`509458b` y `7f44216` difieren solo en `docs/estado-produccion-v1-6-2026-10-11.md`. El código de `web/` de `main`
es el desplegado.

## Documentos de esta carpeta

| Documento | Contenido | Entrega |
| --- | --- | --- |
| [`matriz-aceptacion.md`](matriz-aceptacion.md) | Una fila por control A1–H con evidencia, estado y siguiente acción; discrepancias entre documentos | A |
| [`auditoria-seguridad.md`](auditoria-seguridad.md) | Defensa en profundidad, identidades, secretos, retención de imágenes y `maxScale`, con su evidencia | A |
| [`runbook-operativo.md`](runbook-operativo.md) | Rutinas, señales, incidentes, recuperación y permisos | B |
| [`evidencia.md`](evidencia.md) | Formato de evidencia saneada y cómo evaluarla | B |
| [`mantenimiento-dependencias.md`](mantenimiento-dependencias.md) | Las 5 alertas altas de desarrollo y la cobertura de CI | C |
| [`backlog-v1-7.md`](backlog-v1-7.md) | Hipótesis priorizadas para V1.7, **no aprobadas** | C |
| [`hoja-propietario.md`](hoja-propietario.md) | Acciones irreduciblemente humanas, en orden | C |

## Herramientas (`web/scripts/ops/`)

Las tres son **offline**: no invocan `gcloud`, `curl` ni la red, y nunca leen secretos.

| Script | Uso | Códigos de salida |
| --- | --- | --- |
| `preflight-aceptacion.mjs` | Controles estáticos del repositorio (plantilla, política de limpieza, contrato de seguridad, identidad de la versión) | 0 todo OK · 1 algún FALLO · 3 sin fallos pero con NO_VERIFICADO |
| `plan-inspeccion.mjs` | **Imprime** los comandos de solo lectura que el propietario ejecuta con su cuenta | 0 · 2 uso incorrecto |
| `evidencia.mjs` | Valida un archivo de evidencia saneada, rechaza PII y secretos, y evalúa cada control | 0 todo OK · 1 algún FALLO · 3 NO_VERIFICADO · 4 evidencia rechazada |

## Inventario inicial (discovery)

| Necesidad de la misión | Ya existe | Falta | Propuesta |
| --- | --- | --- | --- |
| Checklist A–H | `despliegue-v1-6-aceptacion.md` | Estado por control, evidencia, responsable | `matriz-aceptacion.md` |
| Smoke sin sesión | `smoke-remote.mjs` (26 comprobaciones; cubierto por `deploy-docs.test.ts`) | — | Reutilizar; no se duplica |
| Política de limpieza | `limpieza-artifact-v1-6.sh --check` y pruebas | Lectura de la etiqueta `produccion` (A9) | Comando en `plan-inspeccion.mjs`; evaluación en `evidencia.mjs` |
| Seguridad de rutas y escritura | `security.test.ts`, `integration-security.test.ts`, E2E de auth e integración | Una vista única con su evidencia | `auditoria-seguridad.md`, que referencia las pruebas sin duplicarlas |
| Plantilla de Cloud Run | `service.template.yaml`, `render.mjs`, `deploy-template.test.ts` | Distinguir plantilla frente a configuración real | `preflight-aceptacion.mjs` (solo plantilla) + `plan-inspeccion.mjs` (lectura real por el propietario) |
| Secretos en assets | `check:client-secrets` y CI con valores falsos | Control positivo: que de verdad detecte una fuga | Autoprueba con valores canario inventados |
| CI | `web-validation.yml` (audit, lint, typecheck, test, build, 5 E2E, check de secretos) y `docker` | — | Reutilizar; no se crean workflows |
| Runbook operativo e incidentes | Rollback y apagado en el runbook histórico | Rutinas, señales, incidentes y permisos | `runbook-operativo.md` |
| Backlog y tareas humanas | `roadmap.md` | V1.7 como hipótesis; hoja del propietario | `backlog-v1-7.md`, `hoja-propietario.md` |
