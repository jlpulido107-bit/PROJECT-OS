# Estado actual — PROJECT-OS

Solo lo vigente. Fecha: 2026-11-22. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md). Operación: [`operacion.md`](operacion.md).
Todo dato lleva su fuente; lo no verificado va como **hipótesis**. Historial (fusiones y despliegues): [`historial.md`](historial.md).

## Decisiones vigentes

- **DEC-POS-002** (sustituye a 001) y **003**: Claude planea, implementa, revisa y corrige en sesiones separadas, con revisión por riesgo ([delegación](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003)).
- **DEC-POS-005** y **007**: el PM es el único escritor, solo por la API del dashboard ([`AGENTS.md`](../AGENTS.md)).
- **DEC-POS-008**: sin ChatGPT; BAJO de solo docs sin revisor; MEDIO con Sonnet y delta ([#95](https://github.com/jlpulido107-bit/PROJECT-OS/pull/95)).
- **DEC-POS-009** (sustituye D1 a D3 de 004): el dictamen vive solo en el PR ([migración](migracion-supervision.md)).
- **DEC-POS-011**: con el «sí» citado el PM aprueba y envía BAJO o MEDIO y marca REVISADA ([`AGENTS.md`](../AGENTS.md)).
- **DEC-POS-013**: el «sí PAQ» autoriza solo altas ([#157](https://github.com/jlpulido107-bit/PROJECT-OS/pull/157)). **DEC-POS-014**: carril ALTO ([#160](https://github.com/jlpulido107-bit/PROJECT-OS/pull/160)).
- **DEC-POS-016**: escritura en NOTAS ([`notas.md`](notas.md)). **DEC-POS-017**: cuándo se despliega ([operación](operacion.md#cuándo-se-despliega-dec-pos-017-aprobada)).
- **DEC-POS-018**: agente de finanzas por cortes, días 15 y fin de mes ([`diseno-finanzas-v3.md`](diseno-finanzas-v3.md), [#219](https://github.com/jlpulido107-bit/PROJECT-OS/pull/219)).
- **DEC-POS-019**: SEGUNDO solo en MEDIO sensible; SENSIBLE vacía = sensible ([#234](https://github.com/jlpulido107-bit/PROJECT-OS/pull/234)).
- **DEC-POS-021** y **022**: SEGUNDO gemini-supervisado, apagado sin `SEGUNDO_GEMINI_SUPERVISADO` ([§8](prueba-gemini.md), [#237](https://github.com/jlpulido107-bit/PROJECT-OS/pull/237)).
- **DEC-POS-023**: el propietario cierra tareas desde el dashboard ([#247](https://github.com/jlpulido107-bit/PROJECT-OS/pull/247)).
- **DEC-POS-024** y **025**: rol Tiempos, solo propone; lee /api/planificacion con su token ([#249](https://github.com/jlpulido107-bit/PROJECT-OS/pull/249), [#260](https://github.com/jlpulido107-bit/PROJECT-OS/pull/260)).
- **DEC-POS-028**: Planificación v2, commit desplegado y columna BANDERA ([diseño](diseno-planificacion-v2.md), [#296](https://github.com/jlpulido107-bit/PROJECT-OS/pull/296), [#295](https://github.com/jlpulido107-bit/PROJECT-OS/pull/295)). **Hipótesis:** APROBADA.
- **DEC-POS-029**: el propietario edita la planificación y tiene calendario ICS ([escritura §11](escritura-v1-8.md), [#310](https://github.com/jlpulido107-bit/PROJECT-OS/pull/310)).
- **DEC-POS-031** (enmienda de 030): Gemini propone en la bandeja y solo el propietario confirma ([escritura §13](escritura-v1-8.md), [#346](https://github.com/jlpulido107-bit/PROJECT-OS/pull/346)). **Hipótesis:** APROBADA.
- **DEC-POS-033** a **038**: APROBADA (PM, hoja, 2026-11-22). En el repositorio solo consta el contenido de tres:
  - **035**: el SEGUNDO nunca es de la familia del implementador ([operación](operacion.md#roles-y-modelos), [#358](https://github.com/jlpulido107-bit/PROJECT-OS/pull/358)).
  - **036**: botón de despliegue, apagado sin `DESPLIEGUE_BOTON` ([guía](despliegue-boton.md), [#364](https://github.com/jlpulido107-bit/PROJECT-OS/pull/364)).
  - **037**: rol Director de Marketing ([`AGENTS.md`](../AGENTS.md), [#360](https://github.com/jlpulido107-bit/PROJECT-OS/pull/360)).
  - **Hipótesis:** 033, 034 y 038 viven solo en DECISIONES; 037 dice ampliar 030 y 034 ([skill](../.claude/skills/director-marketing/SKILL.md)).
- **DEC-ECO-007** y **017**: `idea.alta` en RADAROS con «sí PAQ», apagada sin `ECO_IDEAS_ALTA` ([#306](https://github.com/jlpulido107-bit/PROJECT-OS/pull/306), [#354](https://github.com/jlpulido107-bit/PROJECT-OS/pull/354)).
- **DEC-SIG-003**: las sesiones de SIG leen los libros de prueba con el conector, solo lectura ([#297](https://github.com/jlpulido107-bit/PROJECT-OS/pull/297)).
- **Hipótesis:** DEC-POS-010, 015, 026, 027, 030 y 032, DEC-SIG-002 y DEC-ECO-008 a 016 viven solo en DECISIONES; no sé su estado hoy.

## En curso

- En producción: **por confirmar**. Último registro en el repositorio: `00046-ppl` con ORD-POS-115, del 2026-10-30
  ([#270](https://github.com/jlpulido107-bit/PROJECT-OS/pull/270#issuecomment-6532847729)). **Hipótesis:** hubo despliegues posteriores sin registro aquí.
- Fusionado desde entonces, ORD-POS-118 a 164 ([#274](https://github.com/jlpulido107-bit/PROJECT-OS/pull/274) a [#364](https://github.com/jlpulido107-bit/PROJECT-OS/pull/364); [historial](historial.md)). **Hipótesis:** qué parte está desplegada.
- Banderas: `TAREAS_CIERRE_PROPIETARIO` y `TIEMPOS_AGENTE` encendidas desde `00045` (mismo registro). **Hipótesis:** siguen así, y
  no sé el estado de `ECO_IDEAS_ALTA`, `ECO_BANDEJA_GEMINI`, `SEGUNDO_GEMINI_SUPERVISADO`, `PM_PUEDE_REGISTRAR_PR` ni `DESPLIEGUE_BOTON`.
- Órdenes abiertas (PM, hoja, 2026-11-22): ORD-ECO-057, ORD-POS-165 y ORD-POS-166
  ([issue #365](https://github.com/jlpulido107-bit/PROJECT-OS/issues/365), este estado). ORD-POS-165 tiene PR en borrador, [#367](https://github.com/jlpulido107-bit/PROJECT-OS/pull/367).
- Modelos: implementa y corrige la familia de `FAMILIA_IMPLEMENTADOR` (`politica.ts`), revisa Sonnet, SEGUNDO de otra
  familia que ambos o gemini-supervisado ([operación](operacion.md#roles-y-modelos), [#356](https://github.com/jlpulido107-bit/PROJECT-OS/pull/356), [#358](https://github.com/jlpulido107-bit/PROJECT-OS/pull/358)).
- Riesgo conocido: la reserva supone una sola instancia (`maxScale: 1`) ([migración](migracion-supervision.md)).

## Siguiente

- Incoherencia por decidir (propietario; PM, hoja, 2026-11-22): DEC-POS-036 nombra la cuenta «project-os-deploy» y la variable
  «POS_DESPLIEGUE_ACTIVO»; el código de ORD-POS-163 usa «project-os-despliegue» y «DESPLIEGUE_BOTON» ([#364](https://github.com/jlpulido107-bit/PROJECT-OS/pull/364)). Sin corregir.
- Documentos que aún dicen PENDIENTE: DEC-POS-036 en [`AGENTS.md`](../AGENTS.md), [operación](operacion.md) y la [guía](despliegue-boton.md);
  DEC-POS-018 en [operación](operacion.md). Orden aparte.
- Confirmar la revisión en producción y registrar el despliegue de lo fusionado (propietario, [operación](operacion.md#cuándo-se-despliega-dec-pos-017-aprobada)).
- Botón de despliegue: los pasos son solo del propietario ([guía](despliegue-boton.md)); `actionlint` no corrió en [#364](https://github.com/jlpulido107-bit/PROJECT-OS/pull/364).
- Copias en SIGSAH y RADAROS que aún nombran modelos fijos en `planear-proyecto`, para otra orden ([#358](https://github.com/jlpulido107-bit/PROJECT-OS/pull/358)).
- **Hipótesis:** siguen abiertos los hallazgos BAJA de 109, 110 y 113 ([#254](https://github.com/jlpulido107-bit/PROJECT-OS/pull/254), [#256](https://github.com/jlpulido107-bit/PROJECT-OS/pull/256), [#262](https://github.com/jlpulido107-bit/PROJECT-OS/pull/262)); /eco cambió con 148 a 152.
- **Hipótesis:** sin resultado registrado aquí de las fechas de noviembre que pasaron a [historial](historial.md#hitos-y-fechas-pasadas).

## Cómo se actualiza

Después de fusionar, en un PR aparte, con la skill [`cerrar-orden`](../.claude/skills/cerrar-orden/SKILL.md):
lo vigente aquí y lo que deja de serlo en [`historial.md`](historial.md).
