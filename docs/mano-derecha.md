# Modelo de trabajo V1.7: Claude como mano derecha por proyecto

Cómo planeamos el propietario y Claude cada proyecto, y cómo llegan las tareas a Codex. Decidido por el propietario el
2026-10-13: una sesión de Claude Code por repositorio, órdenes a Codex aprobadas en la hoja y cinco roles.

## Piezas

| Pieza | Dónde vive | Quién escribe |
| --- | --- | --- |
| Fuente operativa: metas, tareas, horas y órdenes | Google Sheets «PROJECT-OS V1 — Tablero maestro» | El propietario. Claude **solo lee** |
| Memoria del proyecto: contexto, decisiones e hipótesis | `docs/brief-proyecto.md` en cada repositorio | Claude propone por PR; el propietario aprueba |
| Conversación de planeación | Una sesión de Claude Code por repositorio (SIG, ECO, POS) | Propietario y Claude |
| Trabajo técnico delegado | Issue «Tarea para Codex» → PR de Codex | Claude abre el issue; Codex abre el PR |
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
- **Ingeniero / arquitecto.** Diseño técnico, riesgos y deuda. Redacta las órdenes para Codex y revisa sus PRs.
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
| `/orden-codex` | Después de que el propietario marque órdenes APROBADA | Valida cada orden, abre su issue sin duplicar y dice qué actualizar en la hoja. Por la mañana revisa los PRs de Codex |

## Ciclo de una orden a Codex

1. **Redactar.** En la sesión del proyecto, Claude redacta la orden como una fila de ORDENES_CODEX, en estado BORRADOR.
2. **Aprobar.** El propietario la pega en la hoja y la pasa a **APROBADA**. Solo él aprueba.
3. **Enviar.** `/orden-codex` abre el issue «Tarea para Codex», con el `ORDEN_ID` en el título. Si ya existe, no abre otro.
4. **Ejecutar.** Codex trabaja la tarea y abre un PR. Cómo se lanza se confirma en la primera prueba (POS-009); ver
   [delegación a Codex](delegacion-codex.md).
5. **Revisar.** Claude revisa el PR contra los criterios de aceptación y deja su evaluación en el PR.
6. **Decidir.** El propietario fusiona o cierra el PR, y actualiza la orden y la tarea en la hoja.

Estados, IDs y reglas: [migración ORDENES_CODEX](migracion-ordenes-codex.md).

## Automatización nocturna

No está activa. Se habilita solo después de dos condiciones:
1. una prueba real del ciclo completo con una orden de riesgo bajo;
2. la aprobación explícita del propietario (regla de `AGENTS.md`).

Hasta entonces, cada paso lo dispara una persona.
