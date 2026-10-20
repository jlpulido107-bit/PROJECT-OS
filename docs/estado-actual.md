# Estado actual — PROJECT-OS

Foto breve para arrancar una sesión. Fecha: 2026-10-20. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md).
Todo dato lleva su fuente; lo que no pude verificar va como **hipótesis**.
Quién hace qué, en qué entorno y cómo fluye una orden: [`operacion.md`](operacion.md).

## Decisiones vigentes

- **DEC-POS-001** (2026-10-16): ChatGPT dirige y supervisa; sustituida en el reparto por DEC-POS-002. Fuente: [delegación](delegacion-codex.md).
- **DEC-POS-002** (2026-10-16): Claude planea, implementa, revisa y corrige en sesiones separadas; el papel de auditor de ChatGPT lo retira DEC-POS-008. Fuente: [`AGENTS.md`](../AGENTS.md).
- **DEC-POS-003** (2026-10-16): la revisión se gradúa por riesgo. Fuente: [política](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003).
- **DEC-POS-004** (2026-10-16): persistencia de la supervisión (D1 a D3), decidida y no implementada. Fuente: [migración](migracion-supervision.md).
- **DEC-POS-005** (2026-10-16): el PM (Claude) solo escribe en la hoja por la API del dashboard (tareas, decisiones PENDIENTE y órdenes BORRADOR); nunca aprueba, cierra ni cambia estados del propietario. Fuente: pestaña DECISIONES.
- **DEC-POS-007** (APROBADA, según el PM): caduca DEC-POS-006 (escritura interina con el conector); el PM escribe solo por la API. Fuente: pestaña DECISIONES, según el PM; [PR #91](https://github.com/jlpulido107-bit/PROJECT-OS/pull/91).
- **DEC-POS-008** (2026-10-17, APROBADA): sin auditoría de ChatGPT. BAJO: revisor Claude con otro modelo; BAJO solo docs: sin revisor;
  MEDIO: Sonnet completo, delta tras corrección y segundo revisor Fable 5.1; ALTO no se delega; máximo 2 rondas; vale el «sí» del
  propietario dado al PM y reenviado al escritor. Fuente: pestaña DECISIONES, según el PM; [delegación](delegacion-codex.md) ([PR #95](https://github.com/jlpulido107-bit/PROJECT-OS/pull/95)).
- **DEC-POS-009** (PENDIENTE del propietario): el dictamen vive solo en el PR y sustituye a D1 a D3 de DEC-POS-004; con ella se
  retirarían POS-012 a 018. Fuente: [migración](migracion-supervision.md); su aprobación no consta en el repositorio.
- **DEC-POS-010** (PENDIENTE del propietario): citada en el [issue #134](https://github.com/jlpulido107-bit/PROJECT-OS/issues/134); **hipótesis:** su contenido vive solo en DECISIONES.

## En curso

- Fusionadas desde el último estado (GitHub, 2026-10-20; 027 a 038 en [PR #111](https://github.com/jlpulido107-bit/PROJECT-OS/pull/111)):
  - [#114](https://github.com/jlpulido107-bit/PROJECT-OS/pull/114) ORD-POS-039, reserva auditada: una sola revisión o corrección por paso.
  - [#115](https://github.com/jlpulido107-bit/PROJECT-OS/pull/115) ORD-POS-040, lote de mejoras menores (segundo revisor, `server-only`, correlativo, `pm-alta.sh`).
  - [#118](https://github.com/jlpulido107-bit/PROJECT-OS/pull/118) ORD-POS-041, valida la URL de sesión de AUDITORIA antes de enlazarla.
  - [#123](https://github.com/jlpulido107-bit/PROJECT-OS/pull/123) ORD-POS-042, diagnóstico visible si falla la lectura de GitHub en /ordenes.
  - [#122](https://github.com/jlpulido107-bit/PROJECT-OS/pull/122) ORD-POS-043, `revisar-orden` y `corregir-pr` para SIGSAH y RADAROS.
  - [#124](https://github.com/jlpulido107-bit/PROJECT-OS/pull/124) ORD-POS-044, criterios numerados uno por línea al crear una orden.
  - [#127](https://github.com/jlpulido107-bit/PROJECT-OS/pull/127) ORD-POS-045, ajustes de la reserva de lanzamiento.
  - [#128](https://github.com/jlpulido107-bit/PROJECT-OS/pull/128) ORD-POS-046, cierre asistido desde /ordenes con el PR fusionado.
  - [#131](https://github.com/jlpulido107-bit/PROJECT-OS/pull/131) ORD-POS-047, guía de operación ([`operacion.md`](operacion.md)).
  - [#132](https://github.com/jlpulido107-bit/PROJECT-OS/pull/132) ORD-POS-048, hallazgos menores de 041, 042 y 043.
- Órdenes abiertas (GitHub, 2026-10-20): ORD-POS-049 ([#134](https://github.com/jlpulido107-bit/PROJECT-OS/issues/134), este estado) y
  ORD-POS-050 ([#133](https://github.com/jlpulido107-bit/PROJECT-OS/issues/133), hallazgos menores de 044, 045 y 046).
- PRs abiertos: [#51](https://github.com/jlpulido107-bit/PROJECT-OS/pull/51), skills de terceros (sin orden en el título), y
  [#116](https://github.com/jlpulido107-bit/PROJECT-OS/pull/116), estado tras 039 y 040, desfasado por este; cerrarlo lo decide el propietario.
- Despliegue: revisión activa `project-os-dashboard-00022-vgt` (2026-10-20, con ORD-POS-041 a 048; fuente: [issue #134](https://github.com/jlpulido107-bit/PROJECT-OS/issues/134));
  **hipótesis:** 039 y 040 ya estaban desplegadas. El propietario despliega con [`deploy.sh --desde-activa`](../web/deploy/cloudrun/deploy.sh).
- Rutinas: las 3 existen y están configuradas desde la revisión 00021 ([`rutina-claude.md`](rutina-claude.md)). Prueba real de
  «Lanzar revisión» el 2026-10-19 con ORD-POS-041: dictamen en el [PR #118](https://github.com/jlpulido107-bit/PROJECT-OS/pull/118),
  reserva y lanzamiento en AUDITORIA. Modelos: implementa y corrige Opus, revisa Sonnet, segundo revisor Fable 5.1 ([operación](operacion.md)).
- Riesgo conocido: la reserva supone una sola instancia (`maxScale: 1`); sin deduplicación multiinstancia ([migración](migracion-supervision.md)).
- Hitos, según el PM (pestaña HITOS): **POS-H1** «Estado y delegación» vence 2026-10-31; **POS-H2** «V2 operada por Claude» vence
  2026-11-14 (faltan la Puerta R y la medición POS-021); ORD-POS-004 está en dos filas de ORDENES_CODEX. **Hipótesis:** sin dato nuevo del PM.
- Verificación E1 de V1.6 el 2026-11-11: el [brief](brief-proyecto.md#riesgos) la cita, pero el issue
  [#22](https://github.com/jlpulido107-bit/PROJECT-OS/issues/22) se cerró como «not planned»; **hipótesis:** sigue pendiente.

## Siguiente

- Decidir DEC-POS-009 y DEC-POS-010 (propietario); con la 009, retirar POS-012 a 018. Fuente: pestaña DECISIONES, según el PM.
- Ejecutar ORD-POS-050 ([#133](https://github.com/jlpulido107-bit/PROJECT-OS/issues/133)) y decidir el destino del PR #116.
- Prueba real de «Cerrar (PR fusionado)» en /ordenes (ORD-POS-046, desplegada en 00022). Fuente: hallazgos del PM en el PR #135.
- Puerta R y medición POS-021 para POS-H2. Fuente: según el PM.

## Cómo se actualiza

Después de fusionar, en un PR aparte (evita conflictos entre PRs en paralelo), con la skill
[`cerrar-orden`](../.claude/skills/cerrar-orden/SKILL.md).
