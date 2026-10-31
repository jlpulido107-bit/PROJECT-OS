# Estado actual — PROJECT-OS

Solo lo vigente. Fecha: 2026-10-31. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md). Operación: [`operacion.md`](operacion.md).
Todo dato lleva su fuente; lo no verificado va como **hipótesis**. Historial (fusiones y despliegues): [`historial.md`](historial.md).

## Decisiones vigentes

- **DEC-POS-002** (2026-10-16, sustituye a 001): Claude planea, implementa, revisa y corrige en sesiones separadas ([delegación](delegacion-codex.md)).
- **DEC-POS-003**: revisión por riesgo ([delegación](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003)).
- **DEC-POS-004**: D1 a D3 decididas, sustituidas por 009 ([migración](migracion-supervision.md)).
- **DEC-POS-005**: el PM es el único escritor, por la API del dashboard ([`AGENTS.md`](../AGENTS.md)).
- **DEC-POS-007**: con 005, el PM escribe solo por la API del dashboard ([operación](operacion.md)).
- **DEC-POS-008** (2026-10-17): sin ChatGPT; BAJO de solo docs sin revisor; MEDIO con Sonnet y delta ([#95](https://github.com/jlpulido107-bit/PROJECT-OS/pull/95)).
- **DEC-POS-009**: el dictamen vive solo en el PR ([migración](migracion-supervision.md)).
- **DEC-POS-011** (2026-10-21): con el «sí» citado el PM aprueba y envía BAJO o MEDIO y marca REVISADA ([`AGENTS.md`](../AGENTS.md)).
- **DEC-POS-013**: el «sí PAQ» autoriza solo altas ([#157](https://github.com/jlpulido107-bit/PROJECT-OS/pull/157)).
- **DEC-POS-014**: carril ALTO ([#160](https://github.com/jlpulido107-bit/PROJECT-OS/pull/160)).
- **DEC-POS-016**: escritura en NOTAS ([`notas.md`](notas.md)).
- **DEC-POS-017**: cuándo se despliega ([operación](operacion.md#cuándo-se-despliega-dec-pos-017-aprobada)).
- **DEC-POS-018**: agente de finanzas por cortes, días 15 y fin de mes ([`diseno-finanzas-v3.md`](diseno-finanzas-v3.md), [#219](https://github.com/jlpulido107-bit/PROJECT-OS/pull/219), [#220](https://github.com/jlpulido107-bit/PROJECT-OS/pull/220)).
- **DEC-POS-019**: Fable como SEGUNDO solo en MEDIO sensible; SENSIBLE vacía = sensible ([#234](https://github.com/jlpulido107-bit/PROJECT-OS/pull/234)).
- **DEC-POS-020**: prueba de Gemini hasta el 2026-11-02 ([`prueba-gemini.md`](prueba-gemini.md), [#230](https://github.com/jlpulido107-bit/PROJECT-OS/pull/230)).
- **DEC-POS-021**: Gemini supervisado como SEGUNDO desde el 2026-11-03 ([§8](prueba-gemini.md)).
- **DEC-POS-022**: origen gemini-supervisado en el código, apagado sin `SEGUNDO_GEMINI_SUPERVISADO` ([escritura §6](escritura-v1-8.md), [#237](https://github.com/jlpulido107-bit/PROJECT-OS/pull/237)).
- **DEC-POS-023**: el propietario cierra tareas desde el dashboard ([#247](https://github.com/jlpulido107-bit/PROJECT-OS/pull/247)).
- **DEC-POS-024**: rol Tiempos, solo propone ([#249](https://github.com/jlpulido107-bit/PROJECT-OS/pull/249)).
- **DEC-POS-025**: Tiempos lee /api/planificacion con su token ([#260](https://github.com/jlpulido107-bit/PROJECT-OS/pull/260)).
- **DEC-POS-026** y **DEC-POS-027**: PENDIENTE (PM, orden ORD-POS-119, 2026-10-30). **Hipótesis:** siguen así hoy.
- **DEC-SIG-002**: pendiente del propietario (DECISIONES). **Hipótesis:** sigue sin decidir.
- **Hipótesis:** DEC-POS-010 y 015 viven solo en DECISIONES.

## En curso

- En producción: `project-os-dashboard-00046-ppl` con ORD-POS-115 (`f7c8a7c`); revertir a `00045`
  ([registro en #270](https://github.com/jlpulido107-bit/PROJECT-OS/pull/270#issuecomment-6532847729)). El PM no vio el smoke.
- `TAREAS_CIERRE_PROPIETARIO` y `TIEMPOS_AGENTE` encendidas desde `00045` (mismo registro; POS-037).
- Órdenes abiertas: ORD-POS-119 ([issue #272](https://github.com/jlpulido107-bit/PROJECT-OS/issues/272), este estado);
  ORD-ECO-018 (Descubrir) y ORD-ECO-019 (camino B) (PM, orden ORD-POS-119, 2026-10-30). **Hipótesis:** sin issue en RADAROS hoy.
- Hitos POS-H1, POS-H2, SIG-H1 y SIG-H2: COMPLETADO (PM, orden ORD-POS-119, 2026-10-30).
- Pipeline real (PM, hoja, 2026-10-29): PRD-0003 (EC-006) en COTIZANDO con 3 cotizaciones SOLICITADA.
- Modelos: implementa y corrige Opus, revisa Sonnet, SEGUNDO Fable 5.1 o gemini-supervisado ([operación](operacion.md)).
- Riesgo conocido: la reserva supone una sola instancia (`maxScale: 1`) ([migración](migracion-supervision.md)).

## Siguiente

- Hallazgos abiertos BAJA en /eco/pipeline (PM, hoja, 2026-10-29): 109 SEGUNDO H1 ([#254](https://github.com/jlpulido107-bit/PROJECT-OS/pull/254#issuecomment-6458814395))
  y 110 SEGUNDO H1 y H2 ([#256](https://github.com/jlpulido107-bit/PROJECT-OS/pull/256)); 113 PRIMERO H1 ([#262](https://github.com/jlpulido107-bit/PROJECT-OS/pull/262)), orden aparte.
- Prueba real del agente de finanzas el 2026-11-01, primer corte de fin de mes ([`diseno-finanzas-v3.md`](diseno-finanzas-v3.md)).
- Cierre de la prueba Gemini el 2026-11-02; desde el 2026-11-03 SEGUNDO gemini-supervisado ([§8](prueba-gemini.md)).
- Primera corrida de Tiempos (`planear-tiempo`, modo LUNES) el 2026-11-02; sin rutina programada.
- Renovar `PROJECT_OS_GH_READ_TOKEN` antes del 2026-11-07 (propietario).
- Decidir DEC-SIG-002, DEC-POS-026 y DEC-POS-027 (propietario). **Hipótesis:** ORD-POS-068 sigue en BORRADOR, por cancelar.

## Cómo se actualiza

Después de fusionar, en un PR aparte, con la skill [`cerrar-orden`](../.claude/skills/cerrar-orden/SKILL.md):
lo vigente aquí y lo que deja de serlo en [`historial.md`](historial.md).
