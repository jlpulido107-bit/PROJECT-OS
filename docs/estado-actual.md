# Estado actual — PROJECT-OS

Foto breve para arrancar una sesión. Fecha: 2026-10-19. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md).
Todo dato lleva su fuente; lo que no pude verificar va como **hipótesis**.

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

## En curso

- Órdenes: sin issues abiertos (GitHub, 2026-10-19). ORD-POS-027 a ORD-POS-040 fusionadas en los PRs #87, #89, #91, #93, #95, #97, #100, #101,
  [#104](https://github.com/jlpulido107-bit/PROJECT-OS/pull/104), [#107](https://github.com/jlpulido107-bit/PROJECT-OS/pull/107),
  [#108](https://github.com/jlpulido107-bit/PROJECT-OS/pull/108), [#110](https://github.com/jlpulido107-bit/PROJECT-OS/pull/110),
  [#114](https://github.com/jlpulido107-bit/PROJECT-OS/pull/114) (reserva auditada: una sola revisión o corrección en curso por paso) y
  [#115](https://github.com/jlpulido107-bit/PROJECT-OS/pull/115) (lote de mejoras menores).
- PR abierto: [#51](https://github.com/jlpulido107-bit/PROJECT-OS/pull/51), skills de terceros (sin orden en el título).
- Despliegue, según el PM: ORD-POS-035 y 036 desplegadas. Pendiente del propietario: desplegar la imagen con #108, #114 y #115; crear
  las 3 rutinas de API (revisar con Sonnet, segundo revisor con Fable, corregir con Opus), sus tokens y secretos, y redesplegar con las
  variables ([`rutina-claude.md`](rutina-claude.md)); prueba real de «Lanzar revisión». Los botones de /ordenes aparecen solo con las rutinas creadas.
- Operación, según el PM: el agente PM escribe por la API con [`scripts/pm-alta.sh`](../scripts/pm-alta.sh) desde el entorno POS · PM
  (token por secreto de red, hash en Secret Manager versión 10); se despliega con
  [`deploy.sh --desde-activa`](../web/deploy/cloudrun/deploy.sh) (revisión activa `project-os-dashboard-00017-5hm`, 2026-10-17; **hipótesis:** ya cambió con los despliegues de ORD-POS-035 y 036).
- Modelos, según el PM: implementa Opus (rutina de ejecución ya cambiada), primer revisor Sonnet, segundo revisor Fable 5.1.
- Riesgos conocidos no bloqueantes, según el PM: con más de una instancia de Cloud Run podrían lanzarse dos sesiones por paso (hoy maxScale 1);
  un error definitivo de la rutina bloquea el paso 2 h ([PR #114](https://github.com/jlpulido107-bit/PROJECT-OS/pull/114), limitación conocida).
- Hitos, según el PM (pestaña HITOS): **POS-H1** «Estado y delegación» vence 2026-10-31 (falta la prueba real de los botones); **POS-025**
  «Dictámenes visibles en /ordenes» sigue PENDIENTE en TAREAS y sustituiría a POS-012 a 018 (DEC-POS-009, pendiente de aprobación del
  propietario); **POS-H2** «V2 operada por Claude» vence 2026-11-14 (faltan la evidencia de la Puerta R y la medición POS-021).
- Limpieza pendiente, según el PM: ORD-POS-004 aparece en dos filas de ORDENES_CODEX.
- Verificación E1 de V1.6 el 2026-11-11: el [brief](brief-proyecto.md#riesgos) la cita, pero el issue
  [#22](https://github.com/jlpulido107-bit/PROJECT-OS/issues/22) se cerró como «not planned»; **hipótesis:** sigue pendiente.

## Siguiente

- Aprobar DEC-POS-009 (decisión del propietario) y, con ella, retirar POS-012 a 018. Fuente: según el PM.
- Desplegar la imagen, crear las rutinas y secretos, y hacer la prueba real de «Lanzar revisión» (POS-H1). Fuente: según el PM.
- Puerta R y medición POS-021 para POS-H2. Fuente: según el PM.
- Implementar DEC-POS-004 con una orden por decisión. Fuente: [migración](migracion-supervision.md).

## Cómo se actualiza

Al cerrar cada orden se reescribe este archivo con la skill `cerrar-orden`. **Hipótesis:** esa skill aún no existe en
`.claude/skills/`; hasta entonces se actualiza en un PR aparte después de fusionar, no dentro de cada orden (evita
conflictos entre PRs en paralelo).
