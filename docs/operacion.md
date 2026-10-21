# Guía de operación — PROJECT-OS

Una página para saber quién hace qué, en qué entorno y cómo fluye una orden de punta a punta. No cambia reglas ni
decisiones: resume las vigentes y enlaza su fuente. Fecha: 2026-10-19. Si algo aquí contradice la fuente, manda la fuente.

## Roles y modelos

| Rol | Quién | Modelo | Fuente |
| --- | --- | --- | --- |
| Propietario | Aprueba órdenes; fusiona, despliega y cierra | — | [`AGENTS.md`](../AGENTS.md), DEC-POS-002 |
| PM | Planea, redacta borradores y delega; único escritor de la hoja, por la API | Claude | DEC-POS-005, DEC-POS-007; [`pm-escribir-api`](../.claude/skills/pm-escribir-api/SKILL.md) |
| Implementador | Ejecuta la orden aprobada: rama → PR con la CI en verde | Opus | Orden ORD-POS-047; [estado actual](estado-actual.md) |
| Primer revisor | Revisa a ciegas (orden, diff y contrato, sin la descripción del PR) | Sonnet | DEC-POS-008; [delegación](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003) |
| Segundo revisor | Solo en MEDIO, a ciegas y sin el dictamen del primero | Fable 5.1 | DEC-POS-008; [delegación](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003) |
| Corrector | Corrige en el mismo PR, máximo 2 rondas por orden | Opus | DEC-POS-003, DEC-POS-008; [`corregir-pr`](../.claude/skills/corregir-pr/SKILL.md) |

Cada función corre en una sesión separada; el revisor nunca es la sesión que implementó y usa otro modelo (DEC-POS-002,
[`AGENTS.md`](../AGENTS.md)). Sin auditor externo: ChatGPT ya no participa (DEC-POS-008).

## Entornos

| Entorno | Qué corre ahí | Qué nunca corre ahí | Fuente |
| --- | --- | --- | --- |
| POS · Ingeniería | Implementar, revisar y corregir (las 4 rutinas) | Escritura en la hoja: no tiene el secreto de red de la API ni usa el conector de Sheets | Orden ORD-POS-047; [`AGENTS.md`](../AGENTS.md) |
| POS · PM | Solo el escritor PM: altas por la API con [`scripts/pm-alta.sh`](../scripts/pm-alta.sh) | Implementar, revisar o corregir; aprobar, enviar, cancelar o cerrar; cambiar `ESTADO` o `BLOQUEO` | DEC-POS-005; [estado actual](estado-actual.md); [`pm-escribir-api`](../.claude/skills/pm-escribir-api/SKILL.md) |
| POS · Ideas | Conversar las ideas con el propietario y entregar paquetes al PM; abrir PRs en NOTAS **solo cuando el propietario lo pide** ([`revisar-ideas`](../.claude/skills/revisar-ideas/SKILL.md)) | Leer `privado/` de NOTAS; push a `main` de NOTAS; escribir en la hoja | Orden ORD-POS-056; [notas](notas.md) |
| Cloud Shell del propietario | Despliegue, rutinas, tokens y secretos | Nada que lance Claude: Claude solo da el script | [`deploy.sh`](../web/deploy/cloudrun/deploy.sh) (cabecera) |

El token de la API lo añade el proxy del entorno POS · PM; nadie lo lee, imprime ni pide
([`pm-escribir-api`](../.claude/skills/pm-escribir-api/SKILL.md#token)).

## Las 4 rutinas y su disparo

Todas son rutinas de Claude Code con disparador de API y **sin horario**; las dispara el dashboard con datos validados,
nunca texto libre. Fuente: [rutina de Claude](rutina-claude.md).

| Rutina | Se dispara | Hace | Skill |
| --- | --- | --- | --- |
| Ejecutar orden | Al pulsar **Aprobar y crear el issue** en `/ordenes` (una sola vez) | Valida el issue y abre el PR | [`ejecutar-orden`](../.claude/skills/ejecutar-orden/SKILL.md) |
| Revisar (Sonnet) | Botón **Lanzar revisión** (primera revisión o delta tras corrección) | Dictamen a ciegas | [`revisar-orden`](../.claude/skills/revisar-orden/SKILL.md) |
| Segundo revisor (Fable 5.1) | Botón **Lanzar segundo revisor** (solo MEDIO) | Dictamen a ciegas, sin el del primero | [`revisar-orden`](../.claude/skills/revisar-orden/SKILL.md) |
| Corregir PR | Botón **Pedir corrección** (dictamen `CAMBIOS`, ronda menor que 2) | Commit nuevo en la misma rama del PR | [`corregir-pr`](../.claude/skills/corregir-pr/SKILL.md) |

En `/ordenes` aparece un solo botón según el dictamen del PR; nunca con riesgo ALTO ni si el head cambió desde que cargó
la página. Los botones de revisión y corrección solo aparecen cuando el propietario crea esas rutinas y sus secretos
(ORD-POS-037, [rutina de Claude](rutina-claude.md#botones-revisar-y-corregir-en-ordenes-ord-pos-037)). Plan B si la
llamada falla: **Ejecutar con Claude** o **Copiar para Claude** ([delegación](delegacion-codex.md#ciclo)).

## Flujo de una orden por riesgo

Común a todas: el PM redacta el borrador → el propietario lo aprueba en `/ordenes` (`ENVIADA` + issue `[ORD-…]`) →
la rutina de ejecución abre el PR → **Registrar el PR detectado** (`PR_ABIERTO`) → revisión según el riesgo → el
propietario decide. Fuente: [delegación](delegacion-codex.md#ciclo) y la
[política por riesgo](delegacion-codex.md#política-de-revisión-por-riesgo-dec-pos-003) (DEC-POS-003, DEC-POS-008).

| Riesgo | Revisión | Botones en `/ordenes` tras el PR |
| --- | --- | --- |
| BAJO | Un revisor Claude a ciegas, con modelo distinto al que implementó | **Lanzar revisión** → si `CAMBIOS`, **Pedir corrección** → **Lanzar revisión** (delta); hasta 2 rondas |
| BAJO solo docs | Sin revisor automático | Ninguno: decide el propietario con el PR |
| MEDIO | Sonnet completo; re-revisión del delta tras cada corrección; Fable 5.1 antes de fusionar | **Lanzar revisión** → **Pedir corrección** ↔ **Lanzar revisión** (delta), máx. 2 rondas → **Lanzar segundo revisor**; luego escala al propietario |
| ALTO | No se delega | Ninguno |

Ningún dictamen autoriza fusión, despliegue ni cierre, y un PR fusionado no cierra la tarea por sí solo
([delegación](delegacion-codex.md#ciclo)).

## Despliegue

Lo corre solo el propietario, en Cloud Shell, con
[`web/deploy/cloudrun/deploy.sh --desde-activa`](../web/deploy/cloudrun/deploy.sh): toma las variables de la revisión
activa, deja prevalecer lo exportado (p. ej. `IMAGE` con el digest nuevo), compara solo los nombres de variables, pide
que escriba «desplegar» y aplica. `--dry-run` muestra la comparación sin aplicar. Conserva las variables de las rutinas
([rutina de Claude](rutina-claude.md#botones-revisar-y-corregir-en-ordenes-ord-pos-037);
[despliegue privado](despliegue-privado-v1-3.md)). Claude da el script; nunca lo ejecuta
([delegación](delegacion-codex.md#ciclo)).

## Qué hace solo el propietario

Fuente: [`AGENTS.md`](../AGENTS.md), DEC-POS-002, DEC-POS-005 y DEC-POS-008.

- Aprobar, enviar o cancelar órdenes y decisiones; cambiar `ESTADO` o `BLOQUEO` en la hoja.
- Dar el «sí» literal a cada alta del PM (vale dado al PM y reenviado al escritor, DEC-POS-008).
- Fusionar PRs, desplegar y cerrar tareas e issues.
- Crear las rutinas, sus tokens y los secretos; cambiar `.github/workflows`, permisos, IAM o configuración de GCP.
- Habilitar cualquier ejecución con horario (`schedule`), tras aprobar una prueba real.
