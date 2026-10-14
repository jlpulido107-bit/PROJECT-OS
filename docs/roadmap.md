# Hoja de ruta de PROJECT-OS

> **Estado vigente (2026-10-11):** la V1.6 está desplegada **en solo lectura**: sin escritura, sin automatizaciones y
> sin usuarios nuevos. Ver la [línea base](operacion-v1-6/linea-base-v1-6.md). Las casillas sin marcar son trabajo
> futuro, no funciones de la V1.6. La automatización futura (tareas, decisiones, planificación y avances) está en la
> [propuesta de arquitectura V1.7](operacion-v1-6/propuesta-arquitectura-v1-7.md), **no aprobada**.

## V1.0 — Estructura (actual)
- [x] Google Sheets maestro con 16 pestañas.
- [x] Repositorio privado identificado e inicializado.
- [x] Colector de evidencia GitHub y pruebas.
- [ ] PR revisado y aprobado.
- [ ] Token de solo lectura con alcance limitado.
- [ ] Prueba real por workflow_dispatch.
- [ ] Validar informes, cobertura y errores.

## V1.1 — Operación
- [ ] Diccionario de datos completo, claves y validaciones.
- [ ] Crear políticas de edición/auditoría.
- [ ] Integración idempotente a Sheets.
- [ ] Conciliación de eventos GitHub y tareas.

## V1.2 — Dashboard web
- [x] UI responsiva y autenticación, solo lectura (`web/`, PR #4 fusionado; validada con Google OAuth y Sheets reales).
- [ ] Lectura y escritura autorizada a Sheets mediante backend seguro.
- [ ] Planificación semanal flexible y cronograma diario.
- [ ] Historial de decisiones y evidencias verificables.

## V1.3 — Acceso remoto privado (Misión 005)
- [x] Imagen Docker segura (Node 22, no root, sin secretos) y prueba en CI sin Google Cloud (PR #6).
- [x] Credenciales sin clave en producción: identidad de Cloud Run (ADC) con alcance de solo lectura (código, PR #6).
- [x] Secretos en Secret Manager; OAuth con redirect HTTPS explícito; allowlist verificada por petición (diseño y código, PR #6).
- [x] Costos controlados en la plantilla: min 0 / max 1 instancia y limpieza de imágenes. El presupuesto con alertas lo crea el propietario.
- [x] Despliegue manual y rollback documentados (`docs/despliegue-privado-v1-3.md`, actualizado a V1.6 en la Misión 010).
- [x] Preparación V1.6: matriz de decisiones, auditoría estática, costos verificados y checklist de aceptación (Misión 010).
- [x] Cloud Build con cuenta dedicada `project-os-build`, verificación de identidad en el build, bucket de origen propio y OAuth interno documentado (Misión 011; sin recursos creados).
- [x] Autorización del usuario para crear recursos facturables y desplegar (V1.6 desplegada, commit `7f44216`; [registro](estado-produccion-v1-6-2026-10-11.md)).
- [ ] Prueba real en Cloud Run: acceso permitido/denegado, datos reales, sin escrituras. Acceso permitido y uso confirmados; denegado, totales y escrituras pendientes ([matriz](operacion-v1-6/matriz-aceptacion.md)).
- [ ] Operación V1.6 (Misión 013): evidencia de solo lectura y [hoja del propietario](operacion-v1-6/hoja-propietario.md). Las hipótesis V1.7 están en el [backlog](operacion-v1-6/backlog-v1-7.md), **no aprobadas**.
- [ ] Cierre V1.6 (Misión 014): [línea base](operacion-v1-6/linea-base-v1-6.md), [matriz](operacion-v1-6/matriz-aceptacion.md) sin falsos aprobados y [acta](operacion-v1-6/acta-cierre-v1-6.md). Falta la aceptación del propietario.

## V1.7 — Estado de proyectos y delegación a Codex
- [x] Primera revisión de estado (hoja + 3 repositorios), 2026-10-13.
- [x] ECO enlazado al repositorio RADAROS en `config/projects.json`.
- [x] Protocolo de [delegación a Codex](delegacion-codex.md), `AGENTS.md` y plantilla «Tarea para Codex» en los 3 repositorios.
- [ ] Configuración de Codex por el propietario y primera tarea de prueba supervisada.
- [ ] Enlace de evidencias con TAREAS por el ID `PRJ-NNN` (propuesta; el colector sigue sin cerrar tareas).
- [x] Página «Estado» en el dashboard (`/estado`): metas con riesgo, plan vs real de la semana y alertas (POS-007). Desplegada el 2026-10-13 ([registro](estado-produccion-v1-7-2026-10-13.md)).
- [ ] [Mano derecha por proyecto](mano-derecha.md): una sesión por repositorio, skills `/planear-proyecto` y `/orden-codex`, y la pestaña [ORDENES_CODEX](migracion-ordenes-codex.md), que aplica el propietario.
- [ ] Ejecución nocturna programada, solo tras aprobar una prueba real.

## V1.8 — Todo desde el dashboard ([plan](plan-v1-8-automatizacion.md))
- [x] F1 Página `/ordenes` (lectura de ORDENES_CODEX). Fusionada; pendiente de desplegar.
- [x] F2 Escritura real limitada para el propietario. Fusionada; se activa con [escritura-v1-8.md](escritura-v1-8.md).
- [x] F3 Crear, aprobar y cancelar órdenes desde el dashboard. Fusionada.
- [x] F4 Envío a GitHub al aprobar. Fusionada y desplegada (revisión `00004`).
- [x] F4b Sin `@codex` (no inicia tareas desde issues): la tarea se lanza con «Copiar para Codex».
- [ ] F5 Revisión matutina programada de los PRs de Codex.

## V1.4 — Informes y planificación (antes V1.3)
- [ ] Captura de avances no técnicos.
- [ ] Cierre diario completo (no solo GitHub).
- [ ] Sugerencias de prioridades y capacidad.
- [ ] Revisión humana de propuestas antes de cambios operativos.
- [ ] Activación controlada del calendario diario.
