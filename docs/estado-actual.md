# Estado actual — PROJECT-OS

Foto breve para arrancar una sesión. Fecha: 2026-10-22. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md).
Todo dato lleva su fuente; lo que no pude verificar va como **hipótesis**.
Quién hace qué, en qué entorno y cómo fluye una orden: [`operacion.md`](operacion.md).

## Decisiones vigentes

- **DEC-POS-001** (2026-10-16): ChatGPT dirige y supervisa; sustituida en el reparto por DEC-POS-002. Fuente: [delegación](delegacion-codex.md).
- **DEC-POS-002** (2026-10-16): Claude planea, implementa, revisa y corrige en sesiones separadas; el papel de auditor de ChatGPT lo retira DEC-POS-008. Fuente: [`AGENTS.md`](../AGENTS.md).
- **DEC-POS-003** (2026-10-16): la revisión se gradúa por riesgo. Fuente: [política](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003).
- **DEC-POS-004** (2026-10-16): persistencia de la supervisión (D1 a D3), decidida y no implementada. Fuente: [migración](migracion-supervision.md).
- **DEC-POS-005** (2026-10-16): el PM (Claude) solo escribe en la hoja por la API del dashboard (tareas, decisiones PENDIENTE y órdenes BORRADOR); nunca cierra ni cambia estados del propietario. Ampliada por DEC-POS-011. Fuente: pestaña DECISIONES.
- **DEC-POS-007** (APROBADA, según el PM): caduca DEC-POS-006 (escritura interina con el conector); el PM escribe solo por la API. Fuente: pestaña DECISIONES, según el PM; [PR #91](https://github.com/jlpulido107-bit/PROJECT-OS/pull/91).
- **DEC-POS-008** (2026-10-17, APROBADA): sin auditoría de ChatGPT. BAJO: revisor Claude con otro modelo; BAJO solo docs: sin revisor;
  MEDIO: Sonnet completo, delta tras corrección y segundo revisor Fable 5.1; ALTO no se delega; máximo 2 rondas; vale el «sí» del
  propietario dado al PM y reenviado al escritor. Fuente: pestaña DECISIONES, según el PM; [delegación](delegacion-codex.md) ([PR #95](https://github.com/jlpulido107-bit/PROJECT-OS/pull/95)).
- **DEC-POS-009** (PENDIENTE del propietario): el dictamen vive solo en el PR y sustituye a D1 a D3 de DEC-POS-004; con ella se
  retirarían POS-012 a 018. Fuente: [migración](migracion-supervision.md); su aprobación no consta en el repositorio.
- **DEC-POS-010** (PENDIENTE del propietario): citada en el [issue #134](https://github.com/jlpulido107-bit/PROJECT-OS/issues/134); **hipótesis:** su contenido vive solo en DECISIONES.
- **DEC-POS-011** (2026-10-21): con el «sí» del propietario citado con la orden y su fecha, el PM aprueba y envía órdenes
  BAJO o MEDIO y marca REVISADA solo con dictamen CONFORME de PRIMERO o DELTA y, en MEDIO, también SEGUNDO de otro modelo
  en el mismo head; CERRADA, CANCELADA y el riesgo ALTO siguen siendo del propietario. Fuente: [`AGENTS.md`](../AGENTS.md);
  código en [PR #146](https://github.com/jlpulido107-bit/PROJECT-OS/pull/146) (ORD-POS-055),
  [#150](https://github.com/jlpulido107-bit/PROJECT-OS/pull/150) (057) y [#152](https://github.com/jlpulido107-bit/PROJECT-OS/pull/152) (059);
  documentación en [`escritura-v1-8.md` §6](escritura-v1-8.md) y [`pm-escribir-api`](../.claude/skills/pm-escribir-api/SKILL.md).

## En curso

- Fusionadas desde el último estado (GitHub, 2026-10-22; 039 a 048 en [PR #135](https://github.com/jlpulido107-bit/PROJECT-OS/pull/135)):
  - [#135](https://github.com/jlpulido107-bit/PROJECT-OS/pull/135) ORD-POS-049, estado actual tras 039 a 048 y uso de `cerrar-orden`.
  - [#136](https://github.com/jlpulido107-bit/PROJECT-OS/pull/136) ORD-POS-050, hallazgos menores de 044, 045 y 046.
  - [#138](https://github.com/jlpulido107-bit/PROJECT-OS/pull/138) ORD-POS-051, CONFORME en repositorios sin CI con las pruebas propias del revisor.
  - [#142](https://github.com/jlpulido107-bit/PROJECT-OS/pull/142) ORD-POS-052, hallazgos menores de 045, 046 y 051.
  - [#141](https://github.com/jlpulido107-bit/PROJECT-OS/pull/141) ORD-POS-053, `corregir-pr`: ronda de solo fusión para un PR CONFORME en conflicto.
  - [#144](https://github.com/jlpulido107-bit/PROJECT-OS/pull/144) ORD-POS-054, notas de ideas en Obsidian ([`notas.md`](notas.md)).
  - [#146](https://github.com/jlpulido107-bit/PROJECT-OS/pull/146) ORD-POS-055, el PM aprueba, envía y marca REVISADA por la API (DEC-POS-011).
  - [#148](https://github.com/jlpulido107-bit/PROJECT-OS/pull/148) ORD-POS-056, skill `revisar-ideas`.
  - [#150](https://github.com/jlpulido107-bit/PROJECT-OS/pull/150) ORD-POS-057, REVISADA del PM solo con CONFORME suficiente.
  - [#152](https://github.com/jlpulido107-bit/PROJECT-OS/pull/152) ORD-POS-059, «sí» ligado a la orden y a la fecha, sin `url` en ENVIAR y reintentos idempotentes.
- Órdenes abiertas (GitHub, 2026-10-22): ORD-POS-058 ([#153](https://github.com/jlpulido107-bit/PROJECT-OS/issues/153), este estado
  y la alineación de docs con DEC-POS-011).
- PRs abiertos: [#51](https://github.com/jlpulido107-bit/PROJECT-OS/pull/51), skills de terceros (sin orden en el título), y
  [#116](https://github.com/jlpulido107-bit/PROJECT-OS/pull/116), estado tras 039 y 040, desfasado; cerrarlo lo decide el propietario.
- Despliegue: última revisión registrada `project-os-dashboard-00022-vgt` (2026-10-20, con ORD-POS-041 a 048; fuente: [issue #134](https://github.com/jlpulido107-bit/PROJECT-OS/issues/134));
  **hipótesis:** 049 a 059 (incluido el código de DEC-POS-011) no constan desplegadas en el repositorio. El propietario despliega con [`deploy.sh --desde-activa`](../web/deploy/cloudrun/deploy.sh).
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
- Desplegar 049 a 059 para que el PM use DEC-POS-011 (propietario) y decidir el destino del PR #116.
- Prueba real de «Cerrar (PR fusionado)» en /ordenes (ORD-POS-046, desplegada en 00022). Fuente: hallazgos del PM en el PR #135.
- Puerta R y medición POS-021 para POS-H2. Fuente: según el PM.

## Cómo se actualiza

Después de fusionar, en un PR aparte (evita conflictos entre PRs en paralelo), con la skill
[`cerrar-orden`](../.claude/skills/cerrar-orden/SKILL.md).
