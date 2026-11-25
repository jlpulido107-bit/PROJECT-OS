# Estado actual — PROJECT-OS

Solo lo vigente. Fecha: 2026-11-25. Memoria duradera: [`brief-proyecto.md`](brief-proyecto.md). Operación: [`operacion.md`](operacion.md).
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
- **DEC-POS-033** a **046**: APROBADAS (033 a 038: PM, hoja, 2026-11-22; 038 a 046: POS · Ideas, 2026-11-25). Lo que consta de su contenido:
  - **033** y **035**: revisores y corrector sin «sí» por ronda; el SEGUNDO nunca es de la familia del implementador ([`AGENTS.md`](../AGENTS.md), [operación](operacion.md#roles-y-modelos), [#358](https://github.com/jlpulido107-bit/PROJECT-OS/pull/358), [#375](https://github.com/jlpulido107-bit/PROJECT-OS/pull/375)).
  - **034** y **040**: la Mac (usuario «taller» y candados) y `main` protegida; 040 fija además los nombres del botón ([candados](mac/candados.md), [#374](https://github.com/jlpulido107-bit/PROJECT-OS/pull/374), [#375](https://github.com/jlpulido107-bit/PROJECT-OS/pull/375)).
  - **036**: botón de despliegue, apagado sin `DESPLIEGUE_BOTON`; en uso desde el 2026-11-22 ([guía](despliegue-boton.md), [#364](https://github.com/jlpulido107-bit/PROJECT-OS/pull/364), [#369](https://github.com/jlpulido107-bit/PROJECT-OS/pull/369)).
  - **037** y **038**: rol Director de Marketing (037 dice ampliar 030 y 034, [skill](../.claude/skills/director-marketing/SKILL.md)); lee sus encargos, apagado sin `DIRECTOR_MKT_LECTURA` ([`AGENTS.md`](../AGENTS.md), [#360](https://github.com/jlpulido107-bit/PROJECT-OS/pull/360), [#377](https://github.com/jlpulido107-bit/PROJECT-OS/pull/377)).
  - **039**: el PM registra el modelo real de cada sesión, apagado sin `SUPERVISION_MODELO_SESION` ([escritura §14](escritura-v1-8.md), [#367](https://github.com/jlpulido107-bit/PROJECT-OS/pull/367)).
  - **044** y **045**: el colector corre con horario diario y el preflight solo tolera ese `schedule` idéntico a su fuente ([operación](operacion.md), [#383](https://github.com/jlpulido107-bit/PROJECT-OS/pull/383), [#384](https://github.com/jlpulido107-bit/PROJECT-OS/pull/384)).
  - **043**, enmendada por **046**: la migración queda en el congelador, con disparadores (POS · Ideas, 2026-11-25). **Hipótesis:** qué migración y qué disparadores, y todo el contenido de **041** y **042**: viven solo en DECISIONES.
- **DEC-ECO-007** y **017**: `idea.alta` en RADAROS con «sí PAQ», apagada sin `ECO_IDEAS_ALTA` ([#306](https://github.com/jlpulido107-bit/PROJECT-OS/pull/306), [#354](https://github.com/jlpulido107-bit/PROJECT-OS/pull/354)).
- **DEC-SIG-003**: las sesiones de SIG leen los libros de prueba con el conector, solo lectura ([#297](https://github.com/jlpulido107-bit/PROJECT-OS/pull/297)).
- **Hipótesis:** DEC-POS-010, 015, 026, 027, 030 y 032, DEC-SIG-002 y DEC-ECO-008 a 016 viven solo en DECISIONES; no sé su estado hoy.

## En curso

- En producción, último registro: revisión `00070-587` con el commit `145afcd` (lo fusionado hasta ORD-POS-171, [#379](https://github.com/jlpulido107-bit/PROJECT-OS/pull/379)), desplegada con el botón el 2026-11-22 y con humo remoto 65/65 ([ejecución 45071096152](https://github.com/jlpulido107-bit/PROJECT-OS/actions/runs/45071096152)). **Hipótesis:** sigue activa; un despliegue posterior por Cloud Shell no dejaría registro aquí.
- Fusionado después de `145afcd`, sin despliegue registrado: ORD-POS-172 y 173 ([#381](https://github.com/jlpulido107-bit/PROJECT-OS/pull/381), [#383](https://github.com/jlpulido107-bit/PROJECT-OS/pull/383)) y el horario del colector ([#384](https://github.com/jlpulido107-bit/PROJECT-OS/pull/384)). Lo anterior, en el [historial](historial.md).
- Banderas: `DIRECTOR_MKT_LECTURA` encendida el 2026-11-22 (`00069-5rs`, [issue #378](https://github.com/jlpulido107-bit/PROJECT-OS/issues/378)); `DESPLIEGUE_BOTON` en `true` ese día (pasó la compuerta de la ejecución 45071096152); `TAREAS_CIERRE_PROPIETARIO` y `TIEMPOS_AGENTE`, desde `00045` ([registro](https://github.com/jlpulido107-bit/PROJECT-OS/pull/270#issuecomment-6532847729)).
  **Hipótesis:** siguen así, y no sé el estado de `ECO_IDEAS_ALTA`, `SEGUNDO_GEMINI_SUPERVISADO`, `PM_PUEDE_REGISTRAR_PR` ni `SUPERVISION_MODELO_SESION`.
- Colector: con horario diario a las 05:00 UTC (23:00 de Mérida) desde el [#384](https://github.com/jlpulido107-bit/PROJECT-OS/pull/384) (2026-11-25; DEC-POS-044 y 045). La primera corrida toca a las 05:00 UTC del 2026-11-26; al escribir esto no hay ninguna con evento `schedule` ([corridas](https://github.com/jlpulido107-bit/PROJECT-OS/actions/workflows/manual-github-evidence.yml)).
- Bandeja de RADAROS: encendida y en uso por Antigravity desde el 2026-11-23, con la app web en su versión 7 (`2f34f5e`) (POS · Ideas, 2026-11-25). **Hipótesis:** sin verificar aquí, tampoco si `ECO_BANDEJA_GEMINI` está encendida en el dashboard.
- Órdenes abiertas con issue: ORD-POS-174 (colector con WIF, sin la clave JSON de P15; [issue #385](https://github.com/jlpulido107-bit/PROJECT-OS/issues/385), sin PR al escribir esto) y ORD-POS-175 ([issue #386](https://github.com/jlpulido107-bit/PROJECT-OS/issues/386), este estado). **Hipótesis:** las demás abiertas en la hoja.
- Modelos: implementa y corrige la familia de `FAMILIA_IMPLEMENTADOR` (`politica.ts`), revisa Sonnet, SEGUNDO de otra familia que ambos o gemini-supervisado ([operación](operacion.md#roles-y-modelos), [#356](https://github.com/jlpulido107-bit/PROJECT-OS/pull/356), [#358](https://github.com/jlpulido107-bit/PROJECT-OS/pull/358)).
- Pruebas: `npm test` de `web/` falla en `main` (`d13a880`) desde el [#384](https://github.com/jlpulido107-bit/PROJECT-OS/pull/384): 8 pruebas de `operacion-v1-6.test.ts` suponen el colector sin `schedule`. El preflight real sigue bien (P11 y P12 OK, P15 NO VERIFICADO); la CI no lo ha mostrado porque `web-validation` solo corre con cambios en `web/` (comprobado el 2026-11-25; salida en el [#387](https://github.com/jlpulido107-bit/PROJECT-OS/pull/387)). Pide una orden de código.
- Riesgo conocido: la reserva supone una sola instancia (`maxScale: 1`) ([migración](migracion-supervision.md)).

## Siguiente

- Textos que aún no lo reflejan, para una orden aparte: [operación](operacion.md) dice DEC-POS-044 PENDIENTE y colector «solo manual», y DEC-POS-018 PENDIENTE; las cabeceras del workflow del botón y de `wif-despliegue.sh` dicen DEC-POS-036 PENDIENTE (código, [#375](https://github.com/jlpulido107-bit/PROJECT-OS/pull/375)).
- Traer al repositorio el contenido de DEC-POS-041, 042, 043 y 046 (PM, desde DECISIONES): aquí solo consta su estado y, de 043 y 046, una frase.
- Colector (propietario): revisar la primera corrida con horario ([operación](operacion.md)); la clave JSON se retira con la guía que pide ORD-POS-174, tras una noche buena ([issue #385](https://github.com/jlpulido107-bit/PROJECT-OS/issues/385)).
- Confirmar la revisión activa y registrar los despliegues que no pasen por el botón (propietario, [operación](operacion.md#cuándo-se-despliega-dec-pos-017-aprobada)).
- La copia de `planear-proyecto` en SIGSAH aún nombra un modelo fijo como segundo revisor ([archivo](https://github.com/jlpulido107-bit/SIGSAH/blob/main/.claude/skills/planear-proyecto/SKILL.md)). **Hipótesis:** la de RADAROS también ([#358](https://github.com/jlpulido107-bit/PROJECT-OS/pull/358)). Para otra orden.
- **Hipótesis:** siguen abiertos los hallazgos BAJA de 109, 110 y 113 ([#254](https://github.com/jlpulido107-bit/PROJECT-OS/pull/254), [#256](https://github.com/jlpulido107-bit/PROJECT-OS/pull/256), [#262](https://github.com/jlpulido107-bit/PROJECT-OS/pull/262)); /eco cambió con 148 a 152. Sin resultado registrado aquí de las fechas de noviembre que pasaron a [historial](historial.md#hitos-y-fechas-pasadas).

## Cómo se actualiza

Después de fusionar, en un PR aparte, con la skill [`cerrar-orden`](../.claude/skills/cerrar-orden/SKILL.md):
lo vigente aquí y lo que deja de serlo en [`historial.md`](historial.md).
