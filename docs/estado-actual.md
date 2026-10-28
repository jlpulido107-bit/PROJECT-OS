# Estado actual — PROJECT-OS

Foto breve para arrancar una sesión. Fecha: 2026-10-28. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md).
Todo dato lleva su fuente; lo que no pude verificar va como **hipótesis**.
Quién hace qué, en qué entorno y cómo fluye una orden: [`operacion.md`](operacion.md).

## Decisiones vigentes

- **DEC-POS-001** a **DEC-POS-004** (2026-10-16): Claude planea, implementa, revisa y corrige en sesiones separadas (002 sustituye
  a 001); revisión por riesgo (003); D1 a D3 decididas y no implementadas (004). Fuente: [delegación](delegacion-codex.md), [migración](migracion-supervision.md).
- **DEC-POS-005** y **DEC-POS-007**: el PM escribe solo por la API del dashboard. **DEC-POS-011** (2026-10-21): con el «sí» citado
  aprueba y envía BAJO o MEDIO y marca REVISADA; CERRADA, CANCELADA y ALTO son del propietario. Fuente: [`AGENTS.md`](../AGENTS.md).
- **DEC-POS-008** (2026-10-17): sin ChatGPT; BAJO de solo docs sin revisor; MEDIO con Sonnet y delta. Fuente: [delegación](delegacion-codex.md) ([#95](https://github.com/jlpulido107-bit/PROJECT-OS/pull/95)).
- **DEC-POS-013** («sí PAQ», [#157](https://github.com/jlpulido107-bit/PROJECT-OS/pull/157)), **DEC-POS-014** (carril ALTO, [#160](https://github.com/jlpulido107-bit/PROJECT-OS/pull/160)), **DEC-POS-016** (escritura en NOTAS, [`notas.md`](notas.md))
  y **DEC-POS-017** (despliegue, [operación](operacion.md#cuándo-se-despliega-dec-pos-017-aprobada)). **Hipótesis:** 010 y 015 viven solo en DECISIONES.
- **DEC-POS-018** (APROBADA): agente de finanzas por cortes (días 15 y fin de mes). Fuente: [`diseno-finanzas-v3.md`](diseno-finanzas-v3.md), [#219](https://github.com/jlpulido107-bit/PROJECT-OS/pull/219), [#220](https://github.com/jlpulido107-bit/PROJECT-OS/pull/220).
- **DEC-POS-019** (APROBADA): Fable como SEGUNDO solo en MEDIO sensible; columna SENSIBLE vacía = sensible. Fuente: [delegación](delegacion-codex.md), [#234](https://github.com/jlpulido107-bit/PROJECT-OS/pull/234).
- **DEC-POS-020** (APROBADA): prueba de Gemini hasta el 2026-11-02, como fija el §5 de [`prueba-gemini.md`](prueba-gemini.md), según el propietario (2026-10-27). Fuente: [#230](https://github.com/jlpulido107-bit/PROJECT-OS/pull/230).
- **DEC-POS-021** (APROBADA): Gemini supervisado como SEGUNDO desde el 2026-11-03. Fuente: [`prueba-gemini.md` §8](prueba-gemini.md), [#237](https://github.com/jlpulido107-bit/PROJECT-OS/pull/237).
- **DEC-POS-022** (APROBADA): origen gemini-supervisado en el código. Fuente: [escritura §6](escritura-v1-8.md), [#234](https://github.com/jlpulido107-bit/PROJECT-OS/pull/234), [#237](https://github.com/jlpulido107-bit/PROJECT-OS/pull/237).
- **DEC-POS-023** (APROBADA según el PM, hoja, 2026-10-28): el propietario marca tareas COMPLETADA desde el dashboard, inerte sin
  `TAREAS_CIERRE_PROPIETARIO`. Fuente: [#247](https://github.com/jlpulido107-bit/PROJECT-OS/pull/247), [escritura §7](escritura-v1-8.md); los docs la dejan condicional a DECISIONES.
- **DEC-POS-024** (APROBADA según el PM, hoja, 2026-10-28): rol Tiempos, enmienda DEC-POS-013. Fuente: [#249](https://github.com/jlpulido107-bit/PROJECT-OS/pull/249),
  [`planear-tiempo`](../.claude/skills/planear-tiempo/SKILL.md); [`AGENTS.md`](../AGENTS.md) y [operación](operacion.md) aún la marcan PENDIENTE.
- Pendientes del propietario: **DEC-POS-009** (dictamen solo en el PR, [migración](migracion-supervision.md)) y **DEC-SIG-002** (texto en DECISIONES).

## En curso

- Fusionadas desde el último estado (GitHub, 2026-10-28; 085 a 103 en el estado anterior):
  - /eco pipeline: 104 [#243](https://github.com/jlpulido107-bit/PROJECT-OS/pull/243) (hallazgos de ORD-POS-102, inerte sin `ECO_PIPELINE_WRITE_MODE`).
  - Tareas: 105 [#246](https://github.com/jlpulido107-bit/PROJECT-OS/pull/246) (instrucciones, inertes sin la columna) y 106 [#247](https://github.com/jlpulido107-bit/PROJECT-OS/pull/247) (cierre por el propietario).
  - Tiempos: 107 [#249](https://github.com/jlpulido107-bit/PROJECT-OS/pull/249) (skill `planear-tiempo`).
  - Según el PM (hoja, 2026-10-28), 103 a 107 están CERRADA, igual que ORD-ECO-013 ([RADAROS #32](https://github.com/jlpulido107-bit/RADAROS/issues/32)).
- Órdenes abiertas (GitHub, 2026-10-28): ninguna, aparte de ORD-POS-108 ([issue #251](https://github.com/jlpulido107-bit/PROJECT-OS/issues/251), este estado).
- Despliegue: revisión activa `project-os-dashboard-00040-bp4` (commit `a150bf6`, con 106), con las variables nuevas
  `TAREAS_CIERRE_PROPIETARIO` y `TAREAS_CIERRE_PROPIETARIO_EMAIL` ([nota del #247](https://github.com/jlpulido107-bit/PROJECT-OS/pull/247#issuecomment-6457491051)). La anterior, `00039-rw9`
  (commit `6053aaf`), trajo 103 a 105 sin variables nuevas ([nota del #246](https://github.com/jlpulido107-bit/PROJECT-OS/pull/246#issuecomment-6453899915)). 107 (solo skill y docs) no requiere despliegue.
- Sin variables `ECO_PIPELINE_*`: /eco/pipeline inerte. Columna `INSTRUCCIONES` activa en TAREAS Q1, según el PM (2026-10-28).
- Rutinas y modelos: implementa y corrige Opus, revisa Sonnet, SEGUNDO Fable 5.1 o gemini-supervisado ([operación](operacion.md)).
- Riesgo conocido: la reserva supone una sola instancia (`maxScale: 1`) ([migración](migracion-supervision.md)).
- Hitos, según el PM (2026-10-28): **SIG-H1** COMPLETADO; **POS-H1** y **SIG-H2** vencen el 2026-10-31. **Hipótesis:** POS-H2 vence el 2026-11-14.

## Siguiente

- Activación de /eco/pipeline (solo el propietario, [`diseno-eco-pipeline.md` §7.2](diseno-eco-pipeline.md)), tras resolver los 3 hallazgos
  no bloqueantes de ORD-POS-104: PRIMERO H1 (ventana de ediciones manuales), PRIMERO H2 (409 al reintentar en 5000 filas) y
  SEGUNDO H1 (`escritura-fallida` en vez de `lectura-fallida`) ([nota del #243](https://github.com/jlpulido107-bit/PROJECT-OS/pull/243#issuecomment-6449971567)).
- Renovar `PROJECT_OS_GH_READ_TOKEN` antes del 2026-11-07 (propietario).
- POS-H1 y SIG-H2 vencen el 2026-10-31; prueba real del agente de finanzas el 2026-11-01 (primer corte de fin de mes).
- Cierre de la prueba Gemini el 2026-11-02 (DEC-POS-020); desde el 2026-11-03 el SEGUNDO es Gemini supervisado ([§8](prueba-gemini.md)).
- Primera corrida del rol Tiempos (`planear-tiempo`, modo LUNES) el lunes 2026-11-02; sin rutina programada.
- Decidir DEC-POS-009 y DEC-SIG-002 (propietario). **Hipótesis:** ORD-POS-068 sigue en BORRADOR, por cancelar.

## Cómo se actualiza

Después de fusionar, en un PR aparte (evita conflictos entre PRs en paralelo), con la skill
[`cerrar-orden`](../.claude/skills/cerrar-orden/SKILL.md).
