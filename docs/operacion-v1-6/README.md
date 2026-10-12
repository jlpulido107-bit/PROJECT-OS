# PROJECT-OS V1.6 — Operación (Misiones 013 y 014)

> **Ámbito:** línea base operativa de la V1.6 **ya desplegada**. Contiene documentación, herramientas offline y
> pruebas. **Nada aquí se ejecutó contra GCP, Google Sheets ni OAuth reales**, y nada autoriza mutaciones de
> producción. Las operaciones del 2026-10-11 las hizo el propietario ([remediación](remediacion-2026-10-11.md)). Issue:
> [#22](https://github.com/jlpulido107-bit/PROJECT-OS/issues/22).
>
> **Para cerrar la V1.6, empezar por aquí:**
>
> 1. [línea base](linea-base-v1-6.md): qué está desplegado y con qué evidencia;
> 2. [hoja del propietario](hoja-propietario.md): ≈ 70 min de comprobaciones humanas;
> 3. [acta de cierre](acta-cierre-v1-6.md): pendiente de aprobación.

## Fuente de verdad

| Qué | Dónde | Naturaleza |
| --- | --- | --- |
| **Línea base congelada** (identidad, configuración, evidencia `EV-xx` y condiciones de reapertura) | [`linea-base-v1-6.md`](linea-base-v1-6.md) | Referencia vigente (Misión 014) |
| Estado observado del despliegue (2026-10-11) | [`estado-produccion-v1-6-2026-10-11.md`](../estado-produccion-v1-6-2026-10-11.md) | Registro fechado del propietario |
| Código **desplegado** | `7f44216bdf85a9832e014f45c27ac643e00ceff9` | Imagen `sha256:f6e46596…5c07`, revisión `project-os-dashboard-00001-gsk` |
| Base de esta misión | `main` en `509458b0025b8d0a178859b24fa4c69d2e8f678e` | Solo documentación posterior al código desplegado |
| Checklist de aceptación | [`despliegue-v1-6-aceptacion.md`](../despliegue-v1-6-aceptacion.md) | Lista de controles A–H |
| Runbook de despliegue y Puerta C | [`despliegue-privado-v1-3.md`](../despliegue-privado-v1-3.md), [`puerta-c-v1-6.md`](../puerta-c-v1-6.md) | **Histórico**: preparación, no estado presente |

`git diff --stat 7f44216 509458b` solo muestra 4 archivos Markdown (`README.md`, el registro de producción, el runbook
y la Puerta C). Por tanto, `web/` en `main` es idéntico al código desplegado.

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
| [`remediacion-2026-10-11.md`](remediacion-2026-10-11.md) | Resultados de la auditoría en Cloud Shell y pasos para corregir A6, A7 y E1 (`web/deploy/infra/remediacion-v1-6.sh`) | Posterior |
| [`linea-base-v1-6.md`](linea-base-v1-6.md) | Qué está desplegado, configuración conocida, registro de evidencias, excepciones propuestas y condiciones de reapertura | Misión 014 |
| [`acta-cierre-v1-6.md`](acta-cierre-v1-6.md) | Acta de cierre preparada, **sin** aprobación: estados posibles, riesgos, excepciones y firma pendiente | Misión 014 |
| [`propuesta-arquitectura-v1-7.md`](propuesta-arquitectura-v1-7.md) | Arquitectura de la automatización futura: opciones, dependencias y riesgos. **No aprobada** y separada de la V1.6 | Misión 014 |

## Herramientas (`web/scripts/ops/`)

Todas son **offline**: no invocan `gcloud`, `curl` ni la red, y nunca leen secretos.

| Script | Uso | Códigos de salida |
| --- | --- | --- |
| `preflight-cierre.mjs` | **Tabla de cierre** `CONTROL \| ESTADO \| EVIDENCIA \| ACCIÓN PENDIENTE`. Reutiliza las demás herramientas; lo que exige GCP, personas, facturación, tiempo o decisiones queda **siempre** en NO_VERIFICADO. `--solo-repositorio` comprueba solo K1–K10 | 0 · 1 FALLO · 3 NO_VERIFICADO |
| `preflight-aceptacion.mjs` | Controles estáticos del repositorio (plantilla, política de limpieza, contrato de seguridad, workflows, identidad de la versión). P12 da FALLO si un workflow automático (PR, push…) usa credenciales de Google o secretos; P15 declara la clave del colector **manual**, nunca como OK | 0 todo OK · 1 algún FALLO · 3 sin fallos pero con NO_VERIFICADO |
| `matriz.mjs` | Reglas de la matriz: estados, resumen, `EV-xx`, identidad, H y excepciones | 0 sin violaciones · 1 con violaciones |
| `plan-inspeccion.mjs` | **Imprime** los comandos de solo lectura que el propietario ejecuta con su cuenta | 0 · 2 uso incorrecto |
| `evidencia.mjs` | Valida un archivo de evidencia saneada, rechaza PII y secretos, y evalúa cada control. Un ejemplo sintético, otra revisión o una cobertura incompleta nunca dan «todo OK» | 0 todo OK · 1 algún FALLO · 3 NO_VERIFICADO · 4 evidencia rechazada |

**`smoke:remote`** (`web/scripts/smoke-remote.mjs`, 26 comprobaciones) es una prueba de acceso **sin sesión**:

- **Qué comprueba:** que lo privado está cerrado y que las cabeceras están bien.
- **Qué no sustituye:** el login real (C1, C2), la validación de Sheets (C1, D1, D2) ni la facturación (F1, F2).
- **Quién la ejecuta:** el propietario, tras cada cambio. Nunca la CI ni Claude.
- **Cobertura:** no se amplía artificialmente. Sus 26 comprobaciones cubren todas las páginas y APIs privadas, y
  `deploy-docs.test.ts` lo verifica.

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
