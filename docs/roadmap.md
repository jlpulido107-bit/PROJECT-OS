# Hoja de ruta de PROJECT-OS

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
- [ ] Autorización del usuario para crear recursos facturables y desplegar.
- [ ] Prueba real en Cloud Run: acceso permitido/denegado, datos reales, sin escrituras.

## V1.4 — Informes y planificación (antes V1.3)
- [ ] Captura de avances no técnicos.
- [ ] Cierre diario completo (no solo GitHub).
- [ ] Sugerencias de prioridades y capacidad.
- [ ] Revisión humana de propuestas antes de cambios operativos.
- [ ] Activación controlada del calendario diario.
