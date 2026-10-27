# Estado actual — PROJECT-OS

Foto breve para arrancar una sesión. Fecha: 2026-10-27. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md).
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
- Pendientes del propietario: **DEC-POS-009** (dictamen solo en el PR, [migración](migracion-supervision.md)) y **DEC-SIG-002** (texto en DECISIONES).

## En curso

- Fusionadas desde el último estado (GitHub, 2026-10-27; 058 a 084 en el estado anterior):
  - Docs y skills del PM: 085 [#204](https://github.com/jlpulido107-bit/PROJECT-OS/pull/204), 086 [#206](https://github.com/jlpulido107-bit/PROJECT-OS/pull/206) (estado), 087 [#210](https://github.com/jlpulido107-bit/PROJECT-OS/pull/210) (`revisar-desviaciones`), 088 [#209](https://github.com/jlpulido107-bit/PROJECT-OS/pull/209) y 089 [#213](https://github.com/jlpulido107-bit/PROJECT-OS/pull/213) (`reporte-consumo`).
  - Finanzas: 091 [#215](https://github.com/jlpulido107-bit/PROJECT-OS/pull/215) (diseño v3), 092 [#219](https://github.com/jlpulido107-bit/PROJECT-OS/pull/219) (rutas del agente, inertes sin `FINANZAS_AGENTE_MODE`) y 093 [#220](https://github.com/jlpulido107-bit/PROJECT-OS/pull/220) (script del agente).
  - Inicio: 090 [#216](https://github.com/jlpulido107-bit/PROJECT-OS/pull/216), 094 [#223](https://github.com/jlpulido107-bit/PROJECT-OS/pull/223) (diseño v2), 096 [#227](https://github.com/jlpulido107-bit/PROJECT-OS/pull/227) (T1 a T5 y G1) y 101 [#238](https://github.com/jlpulido107-bit/PROJECT-OS/pull/238) (T6, solo lectura).
  - /eco pipeline: 095 [#224](https://github.com/jlpulido107-bit/PROJECT-OS/pull/224) (diseño), 097 [#228](https://github.com/jlpulido107-bit/PROJECT-OS/pull/228) (tablero de lectura) y 102 [#239](https://github.com/jlpulido107-bit/PROJECT-OS/pull/239) (escritura, inerte sin `ECO_PIPELINE_WRITE_MODE`).
  - Revisión: 098 [#230](https://github.com/jlpulido107-bit/PROJECT-OS/pull/230) (prueba Gemini), 100 [#234](https://github.com/jlpulido107-bit/PROJECT-OS/pull/234) y 099 [#237](https://github.com/jlpulido107-bit/PROJECT-OS/pull/237) (SEGUNDO gemini-supervisado).
  - Según el PM, en la hoja 099 a 102 están CERRADA y ORD-POS-068 sigue en BORRADOR ([issue #240](https://github.com/jlpulido107-bit/PROJECT-OS/issues/240)).
- Órdenes abiertas (GitHub, 2026-10-27): ORD-POS-103 ([issue #240](https://github.com/jlpulido107-bit/PROJECT-OS/issues/240), PR [#242](https://github.com/jlpulido107-bit/PROJECT-OS/pull/242), este estado) y
  ORD-POS-104 ([issue #241](https://github.com/jlpulido107-bit/PROJECT-OS/issues/241), PR [#243](https://github.com/jlpulido107-bit/PROJECT-OS/pull/243)). Según el PM (hoja, 2026-10-27), las dos están en REVISADA;
  la 104, MEDIO sensible, tiene su revisión PRIMERO en curso.
- Despliegue: revisión activa `project-os-dashboard-00038-qcm` (commit `16c3eac`, con 099, 101 y 102; nota del PM en el [#239](https://github.com/jlpulido107-bit/PROJECT-OS/pull/239)),
  con `SEGUNDO_GEMINI_SUPERVISADO=on` y sin variables `ECO_PIPELINE_*`: /eco/pipeline inerte. Según el PM, la escritura de /finanzas
  del propietario sigue inerte y el agente de finanzas está activo ([issue #240](https://github.com/jlpulido107-bit/PROJECT-OS/issues/240)). **Hipótesis:** 00033 a 00037 (sin nota) llevaron 085 a 098 y 100.
- Rutinas y modelos: implementa y corrige Opus, revisa Sonnet, SEGUNDO Fable 5.1 o gemini-supervisado ([operación](operacion.md)).
- Riesgo conocido: la reserva supone una sola instancia (`maxScale: 1`) ([migración](migracion-supervision.md)).
- Hitos, según el PM: **POS-H1** PENDIENTE, vence 2026-10-31. **Hipótesis:** POS-H2 sigue con vencimiento 2026-11-14.

## Siguiente

- ORD-POS-104 y la activación de /eco/pipeline (solo el propietario, [`diseno-eco-pipeline.md` §7.2](diseno-eco-pipeline.md)).
  ORD-POS-104: [issue #241](https://github.com/jlpulido107-bit/PROJECT-OS/issues/241), PR [#243](https://github.com/jlpulido107-bit/PROJECT-OS/pull/243).
- Renovar `PROJECT_OS_GH_READ_TOKEN` antes del 2026-11-07 (propietario).
- POS-H1 vence el 2026-10-31; prueba real del agente de finanzas el 2026-11-01 (primer corte de fin de mes).
- Cierre de la prueba Gemini el 2026-11-02 (DEC-POS-020, según el propietario, 2026-10-27); desde el 2026-11-03 el SEGUNDO es
  Gemini supervisado y se retira Fable según [§8](prueba-gemini.md).
- Cancelar ORD-POS-068 (propietario) y decidir DEC-POS-009 y DEC-SIG-002.

## Cómo se actualiza

Después de fusionar, en un PR aparte (evita conflictos entre PRs en paralelo), con la skill
[`cerrar-orden`](../.claude/skills/cerrar-orden/SKILL.md).
