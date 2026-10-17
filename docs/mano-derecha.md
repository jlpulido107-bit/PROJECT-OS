# Modelo de trabajo V1.7: Claude como mano derecha por proyecto

Cómo planeamos el propietario y Claude cada proyecto, y cómo se ejecutan las órdenes. Decidido por el propietario el
2026-10-13: una sesión de Claude Code por repositorio y cinco roles. Desde el 2026-10-14 las órdenes se aprueban en el
dashboard y **las ejecuta Claude**; el propietario decide ([órdenes](delegacion-codex.md)). Sin auditor externo desde DEC-POS-008.

## Piezas

| Pieza | Dónde vive | Quién escribe |
| --- | --- | --- |
| Fuente operativa: metas, tareas, horas y órdenes | Google Sheets «PROJECT-OS V1 — Tablero maestro» | El propietario. Claude **solo lee** |
| Memoria del proyecto: contexto, decisiones e hipótesis | `docs/brief-proyecto.md` en cada repositorio | Claude propone por PR; el propietario aprueba |
| Conversación de planeación | Una sesión de Claude Code por repositorio (SIG, ECO, POS) | Propietario y Claude |
| Trabajo técnico por orden | Orden aprobada en el dashboard → issue → PR de Claude | El dashboard abre el issue; Claude abre el PR |
| Vista de conjunto | Dashboard `/estado` | Nadie: solo lectura |

| Proyecto | Repositorio | Sesión |
| --- | --- | --- |
| SIG | `jlpulido107-bit/SIGSAH` | claude.ai/code → repositorio SIGSAH |
| ECO | `jlpulido107-bit/RADAROS` | claude.ai/code → repositorio RADAROS |
| POS | `jlpulido107-bit/PROJECT-OS` | claude.ai/code → repositorio PROJECT-OS |
| DEV | Sin repositorio | Se planea desde la sesión de POS |

## Roles de Claude en cada sesión

Claude contesta con el rol que pida la pregunta y lo nombra. Nunca inventa datos: separa **dato** (de la hoja o del
repositorio), **cálculo** e **hipótesis**.

- **Mano derecha.** Resume el estado, propone las 3 prioridades de la semana, dice qué decisiones necesita del propietario
  y vigila que plan y realidad cuadren.
- **Ingeniero / arquitecto.** Diseño técnico, riesgos y deuda. Redacta las órdenes, las ejecuta cuando están aprobadas y revisa los PRs.
- **Analista de datos.** Plan contra real (ASIGNACIONES contra TIEMPOS), avance por meta y métricas del proyecto. En ECO,
  también las tendencias.
- **Mercadólogo.** Mercado, cliente, competencia, precio, canal y mensaje. Toda afirmación de mercado lleva su fuente o se
  marca como hipótesis.
- **Financiero.** Costos, margen, punto de equilibrio y escenarios con supuestos explícitos. No es asesoría financiera,
  fiscal ni legal certificada.

**Límites que ningún rol cruza:**
- no escribir en la hoja;
- no fusionar ni desplegar sin autorización;
- no secretos ni datos personales;
- en SIG, ningún valor clínico o nutricional: solo se citan fuentes y lo valida nutrición del hospital.

## Rutinas

Cada rutina es una skill de Claude Code en el repositorio (`.claude/skills/`). Se piden por nombre.

| Rutina | Cuándo | Qué hace |
| --- | --- | --- |
| `/planear-proyecto` | Al abrir la sesión y en la revisión semanal | Lee la hoja, el brief y GitHub. Da el parte por roles y propone las filas de TAREAS y ORDENES_CODEX para que el propietario las pegue |
| `/ejecutar-orden` | «ejecuta ORD-…» o el texto de «Copiar para Claude» | Valida la orden aprobada, la ejecuta en la rama de la sesión y abre el PR con la CI en verde. A pedido o por la mañana revisa los PRs de órdenes |

## Ciclo de una orden

1. **Decidir.** El propietario define la tarea; Claude puede redactar los campos.
2. **Aprobar.** En el dashboard, **Aprobar y crear el issue**. Solo el propietario aprueba.
3. **Ejecutar.** El propietario pide «ejecuta ORD-…» en la sesión del repositorio; Claude abre el PR con evidencia.
4. **Decidir.** El propietario revisa, fusiona o pide cambios, y registra el PR y el cierre en el dashboard.

Detalle: [órdenes](delegacion-codex.md). Estados, IDs y reglas: [migración ORDENES_CODEX](migracion-ordenes-codex.md).

## Automatización nocturna

No está activa. Se habilita solo después de dos condiciones:
1. una prueba real del ciclo completo con una orden de riesgo bajo;
2. la aprobación explícita del propietario (regla de `AGENTS.md`).

Hasta entonces, cada paso lo dispara una persona.
